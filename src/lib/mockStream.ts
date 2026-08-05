/**
 * Stand-in for a real provider stream, so the panel's motion and layout can be
 * built and judged before any network code exists.
 *
 * Chunk sizes and delays are deliberately irregular: a perfectly even stream
 * hides the jitter that the blur fade-in has to absorb in practice.
 */

export interface MockStreamHandle {
  cancel: () => void;
}

interface MockStreamCallbacks {
  onChunk: (text: string) => void;
  onDone: () => void;
}

/**
 * Reply used to stress the layout: a very long unbroken token, a long URL, a
 * code block, a wide table-ish line, emoji, and CJK mixed with Latin. If any of
 * these can burst the panel, they will.
 */
const STRESS_REPLY = `好呀，那就来点难为人的东西吧~

超长单词：Pneumonoultramicroscopicsilicovolcanoconiosisandthensome_plus_a_ridiculously_long_identifier_that_will_not_wrap_on_its_own

长链接：https://example.com/a/very/long/path/that/keeps/going/and/going?query=1&another=2&yet_another=3&and_more=4#fragment-that-is-also-long

\`\`\`ts
// 代码块必须自己横向滚动，而不是把面板撑开
const somethingWithAnAbsurdlyLongName = await client.chat.completions.create({ model: "deepseek-reasoner", stream: true });
\`\`\`

表情：🌟✨💫🎭🕰️🔮 和纯 emoji 行：

🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟

中英混排 mixed CJK and Latin text 应该正常换行，不该出现挤压或者溢出。`;

const NORMAL_REPLIES = [
  `嗯？这么快就来找我了。

我还以为你会多犹豫一会儿呢~ 说吧，想聊点什么？`,
  `有意思。

不过在回答之前——你确定要问的是这个吗？有时候人真正想知道的，和嘴上问的，可不是同一件事呢。`,
  `这个嘛……

让我想想。时间这种东西，我一向不太擅长按顺序讲。`,
];

/** Splits text into uneven chunks, the way a real tokenizer would. */
function chunkify(text: string): string[] {
  const chunks: string[] = [];
  let index = 0;
  // A deterministic pseudo-random walk keeps runs reproducible while still
  // looking irregular.
  let seed = 7;
  while (index < text.length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const size = 2 + (seed % 7);
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function pickReply(prompt: string): string {
  const lowered = prompt.toLowerCase();
  if (lowered.includes("stress") || prompt.includes("压力") || prompt.includes("测试")) {
    return STRESS_REPLY;
  }
  const index = prompt.length % NORMAL_REPLIES.length;
  return NORMAL_REPLIES[index] ?? NORMAL_REPLIES[0]!;
}

/**
 * Streams a canned reply. `onChunk` fires per chunk; `onDone` fires once, and
 * is skipped entirely if the stream is cancelled.
 */
export function startMockStream(
  prompt: string,
  { onChunk, onDone }: MockStreamCallbacks,
): MockStreamHandle {
  const chunks = chunkify(pickReply(prompt));
  let index = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = () => {
    if (cancelled) return;

    if (index >= chunks.length) {
      onDone();
      return;
    }

    onChunk(chunks[index]!);
    index += 1;

    // Irregular cadence, with an occasional longer pause to mimic a model
    // hesitating mid-sentence.
    const pause = index % 17 === 0 ? 180 : 22 + (index % 5) * 12;
    timer = setTimeout(pump, pause);
  };

  // A beat before the first chunk, standing in for time-to-first-token.
  timer = setTimeout(pump, 420);

  return {
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
