/** Small independent GIF writer for disposal/timing fixtures; resets LZW between pixels. */
export function gifFixture(
  frames: {
    colors: number[];
    left?: number;
    dispose?: number;
    transparent?: boolean;
    delay?: number;
  }[],
  width = 3,
  repeat?: number,
) {
  const bytes = [
    ...new TextEncoder().encode('GIF89a'),
    width & 255,
    width >> 8,
    1,
    0,
    0x81,
    0,
    0,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
  ];
  if (repeat !== undefined)
    bytes.push(
      0x21,
      0xff,
      11,
      ...new TextEncoder().encode('NETSCAPE2.0'),
      3,
      1,
      repeat & 255,
      repeat >> 8,
      0,
    );
  for (const frame of frames) {
    const delay = frame.delay ?? 10;
    bytes.push(
      0x21,
      0xf9,
      4,
      ((frame.dispose ?? 1) << 2) | (frame.transparent === false ? 0 : 1),
      delay & 255,
      delay >> 8,
      0,
      0,
    );
    bytes.push(
      0x2c,
      frame.left ?? 0,
      0,
      0,
      0,
      frame.colors.length & 255,
      frame.colors.length >> 8,
      1,
      0,
      0,
      2,
    );
    const codes = frame.colors.flatMap((color) => [4, color]).concat(5),
      packed: number[] = [];
    let bits = 0,
      count = 0;
    for (const code of codes) {
      bits |= code << count;
      count += 3;
      while (count >= 8) {
        packed.push(bits & 255);
        bits >>= 8;
        count -= 8;
      }
    }
    if (count) packed.push(bits & 255);
    for (let i = 0; i < packed.length; i += 255) {
      const block = packed.slice(i, i + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0);
  }
  return new Uint8Array([...bytes, 0x3b]);
}
