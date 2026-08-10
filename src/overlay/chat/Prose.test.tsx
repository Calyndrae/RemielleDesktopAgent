// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Prose } from "./Prose";
import type { ToolActivity } from "@/lib/ipc";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { openUrl } from "@tauri-apps/plugin-opener";

const SOURCES: ToolActivity[] = [
  { kind: "search", query: "科技新闻" },
  { kind: "citation", title: "机器狗上新", url: "https://example.cn/robot" },
  { kind: "citation", title: "卫星串起产业链", url: "https://news.example.com/sat" },
];

afterEach(cleanup);

describe("Prose", () => {
  it("renders bold, headings and lists instead of printing the syntax", () => {
    const { container } = render(
      <Prose text={"## 标题\n\n**要点**如下：\n\n- 第一\n- 第二"} tools={[]} />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("标题");
    expect(container.querySelector("strong")?.textContent).toBe("要点");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    // The raw markers must be gone from the rendered text.
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("##");
  });

  it("renders inline and display LaTeX through KaTeX", () => {
    const { container } = render(
      <Prose
        text={"能量是 $$E = mc^2$$。\n\n$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$"}
        tools={[]}
      />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("turns [n] into a clickable chip that opens the source", () => {
    render(<Prose text={"机器狗要长出常识了 [1]，卫星也有动静 [2]。"} tools={SOURCES} />);
    const chip = screen.getByRole("button", { name: "来源 1：机器狗上新" });
    chip.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.cn/robot");
    expect(screen.getByRole("button", { name: "来源 2：卫星串起产业链" })).toBeTruthy();
  });

  it("leaves [n] alone when no source with that number exists", () => {
    const { container } = render(<Prose text={"数组下标 [3] 或 [12] 不是引用。"} tools={SOURCES} />);
    expect(container.querySelectorAll(".cite")).toHaveLength(0);
    expect(container.textContent).toContain("[3]");
  });

  it("leaves [n] inside code untouched", () => {
    const { container } = render(
      <Prose text={"行内 `arr[1]` 和\n\n```\nlist[2] = 0\n```"} tools={SOURCES} />,
    );
    expect(container.querySelectorAll(".cite")).toHaveLength(0);
    expect(container.textContent).toContain("arr[1]");
    expect(container.textContent).toContain("list[2] = 0");
  });

  it("routes ordinary links through the system opener, not navigation", () => {
    const { container } = render(
      <Prose text={"看看 [官网](https://example.org/page) 吧。"} tools={[]} />,
    );
    const link = container.querySelector("a.prose__link") as HTMLAnchorElement;
    link.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.org/page");
  });

  it("never renders model-written HTML as markup", () => {
    const { container } = render(
      <Prose text={'<img src=x onerror="window.__pwned=1"> **safe**'} tools={[]} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("wraps tables so a wide one scrolls instead of widening the panel", () => {
    const { container } = render(
      <Prose text={"| a | b |\n|---|---|\n| 1 | 2 |"} tools={[]} />,
    );
    expect(container.querySelector(".prose__tablewrap table")).not.toBeNull();
  });

  it("closes bold against full-width punctuation, the CJK flanking trap", () => {
    const { container } = render(
      <Prose text={"**要点：**说明文字。这一点**非常重要。**下一句。"} tools={[]} />,
    );
    expect(container.querySelectorAll("strong")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("keeps bold closed when a citation is the last thing inside it", () => {
    const { container } = render(<Prose text={"**结论[1]**如上。"} tools={SOURCES} />);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("strong .cite")).not.toBeNull();
    expect(container.textContent).not.toContain("**");
  });

  it("does not turn two prices into one giant formula", () => {
    const { container } = render(
      <Prose text={"苹果股价 $150，微软股价 $300。"} tools={[]} />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$150");
    expect(container.textContent).toContain("$300");
  });

  it("renders backslash TeX delimiters, which DeepSeek models actually emit", () => {
    const { container } = render(
      <Prose text={"质能方程 \\(E = mc^2\\)，推导：\\[\\int_0^1 x\\,dx\\]"} tools={[]} />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps TeX syntax literal inside code", () => {
    const { container } = render(
      <Prose text={"行内公式写作 `\\(x\\)` 就行。"} tools={[]} />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("\\(x\\)");
  });

  it("accepts full-width bracket citations 【n】", () => {
    render(<Prose text={"研究表明【1】。"} tools={SOURCES} />);
    expect(screen.getByRole("button", { name: "来源 1：机器狗上新" })).toBeTruthy();
  });

  it("never hands a non-web href to the system opener", () => {
    vi.mocked(openUrl).mockClear();
    const { container } = render(<Prose text={"如图[1](详见附录)"} tools={SOURCES} />);
    const anchors = container.querySelectorAll("a");
    anchors.forEach((a) => (a as HTMLElement).click());
    expect(openUrl).not.toHaveBeenCalled();
  });
});
