/**
 * CodeMirror 6 extension that hides PrimeTask sync markers (`%%pt:id%%` and
 * `<!-- pt:id -->`) in Live Preview mode.
 *
 * Obsidian renders `%%comment%%` as hidden in Reading mode but still shows
 * the raw text in Live Preview. This extension closes that gap by replacing
 * each marker with an empty widget while editing in Live Preview, while
 * leaving Source mode untouched (so power users can still see/edit the IDs).
 *
 * Markers are revealed when the cursor or selection overlaps them, matching
 * how Obsidian itself treats hidden syntax (e.g. wikilink internals).
 */

import { editorLivePreviewField } from 'obsidian';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

const MARKER_RE = /%%\s*pt:[a-zA-Z0-9_-]+\s*%%|<!--\s*pt:[a-zA-Z0-9_-]+\s*-->/g;

class HiddenMarkerWidget extends WidgetType {
  toDOM(): HTMLElement {
    return document.createElement('span');
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Only hide in Live Preview — Source mode keeps everything visible.
  const isLivePreview = view.state.field(editorLivePreviewField, false);
  if (!isLivePreview) return builder.finish();

  const widget = Decoration.replace({ widget: new HiddenMarkerWidget() });
  const ranges = view.state.selection.ranges;

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      // Reveal the marker if the cursor / selection touches it, so the
      // user can still delete it or edit around it without surprises.
      const overlaps = ranges.some((r) => r.from <= end && r.to >= start);
      if (overlaps) continue;
      builder.add(start, end, widget);
    }
  }
  return builder.finish();
}

export const hidePtMarkersExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
