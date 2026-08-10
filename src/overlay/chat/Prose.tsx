import { useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import { visit } from "unist-util-visit";
import type { Root, Text, Parent } from "mdast";

import type { ToolActivity } from "@/lib/ipc";
import { Icon } from "./icons";

/** The citation variant of ToolActivity, once the filter has done its work. */
type Citation = Extract<ToolActivity, { kind: "citation" }>;

import "katex/dist/katex.min.css";

/**
 * Her reply, rendered.
 *
 * The model writes markdown and LaTeX because every model does; until this
 * existed the panel printed the asterisks and dollar signs literally, which
 * reads as a broken app rather than a formatted answer. Rendering happens
 * through a real parser into React elements — never through an HTML string —
 * so nothing the model says can smuggle markup into the page.
 *
 * Citations are part of the same story. The search preflight numbers its
 * results and tells her to cite like `[2]`; here those tokens become the
 * actual link — favicon, source name on hover, click to open — instead of a
 * bracketed number the user has to cross-reference by hand in the sources
 * list.
 */

/**
 * `[2]`, `[2][5]`, and the full-width `【2】` a Chinese model drifts into deep
 * in a long reply no matter what the citation rule said.
 */
const CITATION = /[[【](\d{1,2})[\]】]/g;

/**
 * `\(inline\)` and `\[display\]` TeX delimiters, rewritten to the dollar
 * forms remark-math speaks.
 *
 * This has to happen on the raw string: CommonMark consumes `\(` as a
 * backslash-escape during parsing, so by the time any remark transform runs
 * the backslash is gone and the delimiters are unrecognizable. Single-dollar
 * math stays disabled — 「苹果股价 $150，微软股价 $300」 was rendering
 * everything between two prices as one giant formula — so inline math becomes
 * the `$$…$$` inline form instead. Code is protected by splitting on fences
 * and spans first, which is what keeps a sample that *demonstrates* TeX
 * syntax intact.
 */
export function preprocessTex(source: string): string {
  const parts = source.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body}\n$$\n`)
            .replace(/\\\((.+?)\\\)/g, (_, body: string) => `$$${body}$$`),
    )
    .join("");
}

/** Scheme for smuggling a citation index through mdast as a link. */
const CITE_HREF = "cite:";

/**
 * Remark plugin: turn `[n]` in plain text into `cite:n` links, when a source
 * with that number actually exists. Text inside code spans and fenced blocks
 * never passes through here — remark has already parsed those into nodes this
 * visitor does not touch — so `arr[0]` in a code sample survives.
 */
function remarkCitations(sourceCount: number) {
  return () => (tree: Root) => {
    if (sourceCount === 0) return;
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      // A link's own label must stay text; nesting links is illegal HTML.
      if (parent.type === "link") return;

      const value = node.value;
      CITATION.lastIndex = 0;
      if (!CITATION.test(value)) return;

      const parts: Array<Text | { type: "link"; url: string; children: Text[] }> = [];
      let cursor = 0;
      CITATION.lastIndex = 0;
      for (const match of value.matchAll(CITATION)) {
        const n = Number(match[1]);
        const at = match.index ?? 0;
        // [12] with 8 sources is just text the model wrote, not a citation.
        if (n < 1 || n > sourceCount) continue;
        if (at > cursor) {
          parts.push({ type: "text", value: value.slice(cursor, at) });
        }
        parts.push({
          type: "link",
          url: `${CITE_HREF}${n}`,
          children: [{ type: "text", value: String(n) }],
        });
        cursor = at + match[0].length;
      }
      if (parts.length === 0) return;
      if (cursor < value.length) {
        parts.push({ type: "text", value: value.slice(cursor) });
      }
      (parent as Parent).children.splice(index, 1, ...(parts as Parent["children"]));
      // Skip past what was inserted so the visitor does not re-enter it.
      return index + parts.length;
    });
  };
}

/** The favicon service the CSP allows. DuckDuckGo's returns real 404s. */
function faviconFor(url: string): string | null {
  try {
    return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * One numbered citation, wearing its source's face.
 *
 * The favicon can fail — offline, a host with no icon — and the chip has to
 * degrade to something that still reads as "a source": the number keeps its
 * place, a globe stands in for the icon.
 */
function CitationChip({ n, source }: { n: number; source: Citation }) {
  const [iconFailed, setIconFailed] = useState(false);
  const icon = faviconFor(source.url);

  return (
    <button
      type="button"
      className="cite"
      title={`${source.title}\n${hostOf(source.url)}`}
      aria-label={`来源 ${n}：${source.title}`}
      onClick={() => void openUrl(source.url)}
    >
      {icon && !iconFailed ? (
        <img
          className="cite__icon"
          src={icon}
          alt=""
          loading="lazy"
          onError={() => setIconFailed(true)}
        />
      ) : (
        <Icon.Globe size={10} className="cite__icon" />
      )}
      <span className="cite__n">{n}</span>
    </button>
  );
}

interface ProseProps {
  text: string;
  /** The reply's tool activities; citations are drawn from these, in order. */
  tools: ToolActivity[];
  /** Appends the streaming caret inside the last block. */
  streaming?: boolean;
}

export function Prose({ text, tools, streaming = false }: ProseProps) {
  const sources = tools.filter((t): t is Citation => t.kind === "citation");

  return (
    <div className={`prose${streaming ? " prose--streaming" : ""}`}>
      <Markdown
        remarkPlugins={[
          remarkGfm,
          // CommonMark's emphasis flanking rules treat full-width punctuation
          // as punctuation, so 「**要点：**说明」 never closed its bold and
          // printed the asterisks. This plugin fixes the flanking rules for
          // CJK; it exists because every CJK markdown renderer hits this.
          remarkCjkFriendly,
          [remarkMath, { singleDollarTextMath: false }],
          remarkCitations(sources.length),
        ]}
        rehypePlugins={[[rehypeKatex, { errorColor: "inherit", strict: false }]]}
        // The default transform strips unknown protocols — sound policy, but
        // it eats the `cite:` scheme the citation plugin smuggles through.
        // Let ours pass; everything else keeps the default scrutiny.
        urlTransform={(url) => (url.startsWith(CITE_HREF) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith(CITE_HREF)) {
              const n = Number(href.slice(CITE_HREF.length));
              const source = sources[n - 1];
              if (source) return <CitationChip n={n} source={source} />;
              // A cite: link with no source behind it must never become a
              // real anchor — openUrl("cite:3") asks the OS to open a
              // scheme nothing handles. Degrade to the text it came from.
              return <>[{n}]</>;
            }
            // Only real web links become anchors. Markdown link syntax can
            // arise by accident — 「如图[1](详见附录)」 parses as a link whose
            // href is the parenthetical — and handing that to the system
            // opener asks the OS to open percent-encoded Chinese. Anything
            // that is not http(s)/mailto renders as its text.
            let scheme = "";
            try {
              scheme = href ? new URL(href).protocol : "";
            } catch {
              scheme = "";
            }
            if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") {
              return <>{children}</>;
            }
            // Ordinary links open in the system browser. The panel itself
            // must never navigate — it *is* the app.
            return (
              <a
                href={href}
                className="prose__link"
                onClick={(event) => {
                  event.preventDefault();
                  if (href) void openUrl(href);
                }}
              >
                {children}
              </a>
            );
          },
          // The panel is 400px wide; a table that cannot shrink scrolls
          // inside its own strip instead of stretching the bubble.
          table: ({ children }) => (
            <div className="prose__tablewrap">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre className="code">{children}</pre>,
        }}
      >
        {preprocessTex(text)}
      </Markdown>
      {/* The caret is a ::after on the last text block — see chat.css. A real
          element here always rendered on its own line below the reply. */}
    </div>
  );
}
