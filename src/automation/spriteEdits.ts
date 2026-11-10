import {
  deleteFrame,
  moveFrame,
  newId,
  resizeCanvas,
  validateDocument,
  type SpriteDocument,
  type AnimationTag,
} from '../sprites/model';
import { assertParams, integer, numberInRange, textValue } from './data';

/** Validate and build a complete copy before committing one undoable edit. */
export function applySpriteOperations(source: SpriteDocument, operations: unknown): SpriteDocument {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64)
    throw Error('Provide 1–64 sprite operations.');
  let doc: SpriteDocument = {
    ...source,
    pivot: { ...source.pivot },
    tags: source.tags.map((tag) => ({ ...tag })),
    frames: source.frames.map((frame) => ({ ...frame, pixels: frame.pixels.slice() })),
  };
  let pixelCount = 0;
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation))
      throw Error('Each operation must be an object.');
    const op = operation as Record<string, unknown>;
    const frame = () => integer(op.frame, 'Frame index', 0, doc.frames.length - 1);
    switch (op.type) {
      case 'pixels': {
        assertParams(op, ['type', 'frame', 'pixels']);
        const index = frame();
        if (
          !Array.isArray(op.pixels) ||
          !op.pixels.length ||
          (pixelCount += op.pixels.length) > 4096
        )
          throw Error('Provide 1–4096 pixel edits per command.');
        for (const pixel of op.pixels) {
          assertParams(pixel, ['x', 'y', 'rgba']);
          const x = integer(pixel.x, 'Pixel X', 0, doc.width - 1),
            y = integer(pixel.y, 'Pixel Y', 0, doc.height - 1);
          if (!Array.isArray(pixel.rgba) || pixel.rgba.length !== 4)
            throw Error('RGBA must contain four byte values.');
          const rgba = pixel.rgba.map((value) => integer(value, 'RGBA component', 0, 255));
          doc.frames[index].pixels.set(rgba, (y * doc.width + x) * 4);
        }
        break;
      }
      case 'duration':
        assertParams(op, ['type', 'frame', 'duration']);
        doc.frames[frame()].duration = integer(op.duration, 'Frame duration', 10, 60000);
        break;
      case 'pivot':
        assertParams(op, ['type', 'x', 'y']);
        doc.pivot = {
          x: numberInRange(op.x, 'Pivot X', 0, doc.width),
          y: numberInRange(op.y, 'Pivot Y', 0, doc.height),
        };
        break;
      case 'rename':
        assertParams(op, ['type', 'name']);
        doc.name = textValue(op.name, 'Asset name');
        break;
      case 'tag': {
        assertParams(op, ['type', 'name', 'from', 'to', 'direction']);
        const name = textValue(op.name, 'Tag name', 60),
          from = integer(op.from, 'First frame', 0, doc.frames.length - 1),
          to = integer(op.to, 'Last frame', from, doc.frames.length - 1);
        if (!['forward', 'reverse', 'pingpong'].includes(String(op.direction)))
          throw Error('Choose forward, reverse or pingpong.');
        const tag = { name, from, to, direction: op.direction as AnimationTag['direction'] };
        doc.tags = [...doc.tags.filter((tag) => tag.name !== name), tag];
        break;
      }
      case 'remove_tag': {
        assertParams(op, ['type', 'name']);
        const name = textValue(op.name, 'Tag name', 60);
        if (!doc.tags.some((tag) => tag.name === name))
          throw Error('Animation tag does not exist.');
        doc.tags = doc.tags.filter((tag) => tag.name !== name);
        break;
      }
      case 'duplicate_frame': {
        assertParams(op, ['type', 'frame']);
        const index = frame();
        if (
          doc.frames.length >= 256 ||
          doc.width * doc.height * (doc.frames.length + 1) > 16_000_000
        )
          throw Error('Duplicating this frame exceeds the sprite size limit.');
        doc.frames.splice(index + 1, 0, {
          ...doc.frames[index],
          id: newId(),
          pixels: doc.frames[index].pixels.slice(),
        });
        doc.tags = doc.tags.map((tag) => ({
          ...tag,
          from: tag.from > index ? tag.from + 1 : tag.from,
          to: tag.to > index ? tag.to + 1 : tag.to,
        }));
        break;
      }
      case 'delete_frame':
        assertParams(op, ['type', 'frame']);
        if (doc.frames.length === 1) throw Error('Keep at least one sprite frame.');
        doc = deleteFrame(doc, frame());
        break;
      case 'move_frame':
        assertParams(op, ['type', 'from', 'to']);
        doc = moveFrame(
          doc,
          integer(op.from, 'Source frame', 0, doc.frames.length - 1),
          integer(op.to, 'Destination frame', 0, doc.frames.length - 1),
        );
        break;
      case 'resize_canvas':
        assertParams(op, ['type', 'width', 'height']);
        doc = resizeCanvas(
          doc,
          integer(op.width, 'Canvas width', 1, 512),
          integer(op.height, 'Canvas height', 1, 512),
        );
        break;
      default:
        throw Error(`Unknown sprite operation: ${String(op.type)}.`);
    }
    validateDocument(doc);
  }
  return doc;
}
