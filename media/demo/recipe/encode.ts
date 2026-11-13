// Encodes the last raw take (media/demo/.raw/demo-raw.mp4) into media/demo/ with the demo-video
// skill's encoder: cards, the captions from captions.vtt, music.opus at about -28 LUFS, posters.
// Run from the repository root: deno run -A media/demo/recipe/encode.ts
import { encodeDemo } from "../../../ai-harnesses/skills/demo-video/encode.ts"

const demo = new URL("..", import.meta.url).pathname
const summary = await encodeDemo({
  take: `${demo}.raw/demo-raw.mp4`,
  out: demo.replace(/\/$/, ""),
  title: "dotfiles",
  claim: "My AI-agent setup and Linux workstation, as code.",
  end: "github.com/spy4x/dotfiles",
  // The poster: the three rendered copies side by side, this many seconds into the take.
  poster: 18,
})
console.log(JSON.stringify(summary, null, 2))
