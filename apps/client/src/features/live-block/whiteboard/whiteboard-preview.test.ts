import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  previewNeedsSaving,
  readPreviewMeta,
  sceneFingerprint,
  shouldSavePreview,
  writePreviewMeta,
} from "./whiteboard-preview";

const el = (id: string, version: number, extra: any = {}) => ({
  id,
  version,
  versionNonce: 0,
  isDeleted: false,
  ...extra,
});

describe("shouldSavePreview", () => {
  it("only an editor saves, and only when the scene differs from the stored preview's", () => {
    expect(shouldSavePreview({ isEditor: false, sceneDiffers: true })).toBe(
      false,
    );
    expect(shouldSavePreview({ isEditor: true, sceneDiffers: false })).toBe(
      false,
    );
    expect(shouldSavePreview({ isEditor: true, sceneDiffers: true })).toBe(
      true,
    );
  });
});

describe("sceneFingerprint", () => {
  it("changes when an element changes and ignores order and deleted elements", () => {
    const a = sceneFingerprint([el("1", 1), el("2", 1)]);
    expect(sceneFingerprint([el("2", 1), el("1", 1)])).toBe(a);
    expect(
      sceneFingerprint([
        el("1", 1),
        el("2", 1),
        el("3", 4, { isDeleted: true }),
      ]),
    ).toBe(a);
    expect(sceneFingerprint([el("1", 2), el("2", 1)])).not.toBe(a);
  });
});

describe("previewNeedsSaving", () => {
  it("compares the scene and the node's preview with what the stored preview was made from", () => {
    const doc = new Y.Doc();
    const scene = [el("1", 1)];
    // a board with drawing and no preview yet
    expect(previewNeedsSaving(doc, scene, null)).toBe(true);
    // an empty board with no preview: nothing to show
    expect(previewNeedsSaving(doc, [], null)).toBe(false);
    writePreviewMeta(doc, sceneFingerprint(scene), "att-1");
    expect(readPreviewMeta(doc)).toEqual({
      scene: sceneFingerprint(scene),
      attachmentId: "att-1",
    });
    expect(previewNeedsSaving(doc, scene, "att-1")).toBe(false);
    // someone else drew since
    expect(previewNeedsSaving(doc, [el("1", 2)], "att-1")).toBe(true);
    // a copied block lost its preview attributes: it needs its own file
    expect(previewNeedsSaving(doc, scene, null)).toBe(true);
  });
});
