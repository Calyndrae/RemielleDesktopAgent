# Little Remielle asset pack

The GIF files are **not yet in this directory**. Drop these seven files here,
taken from the [Little-Remielle](https://github.com/ZanyZebra1127/Little-Remielle)
release (`gif/` folder):

```
待机.gif        拿笔待机.gif    思考.gif
连续绘制.gif    间歇绘制.gif    期待.gif        得意.gif
```

`pack.json` already declares all seven and maps them to agent states. The app
validates the pack on load and will name the exact missing file if one is absent.

## Two values still need porting from the original project

Both are placeholders right now and will make the sprite look wrong until they
are corrected against the real files:

1. **`frameSize`** — currently `300x300`. Set it to the actual pixel dimensions
   of the GIFs.
2. **`offset` on each animation** — currently all `0,0`. The original project
   stores these in `坐标配置.json`; each GIF has a different canvas alignment, so
   without the real numbers the character visibly jumps when it switches between
   idle, thinking and drawing.

## Licensing

These assets are **CC BY-NC-SA 4.0**, not MIT — see `LICENSE-ASSETS` and
`NOTICE.md` in the repository root. Attribution chain:

- Character and original material © HoYoverse, *Zenless Zone Zero*
- Animation: 森哈_Yeah (bilibili)
- Desktop pet asset pack: ZanyZebra1127
