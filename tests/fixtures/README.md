# Media fixtures

`green-screen.webm` is a one-second, 4:3 green-screen animation used by the browser workflow tests.

`green-screen.mp4` is an actual H.264 / YUV420P MP4 of the same animation. It covers the browser's MP4 decoding path, rather than renaming a WebM file. Regenerate it with FFmpeg:

```sh
ffmpeg -i tests/fixtures/green-screen.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an tests/fixtures/green-screen.mp4
```

GIF fixtures are generated independently by `tests/helpers/gif-fixture.ts` so tests can choose exact colors, disposal methods, frame delays, and repeat counts.
