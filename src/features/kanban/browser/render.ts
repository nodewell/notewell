// Board rendering for the webview. DOM-free (structural element types from dom.ts),
// so it runs under node:test with a fake document. Every piece of card text goes in
// as a text node or textContent; interaction hooks are data-* attributes that
// main.ts handles by event delegation.
import { createElementFactory, type DomDocument, type DomElement } from '../../../webview/dom.ts';
import { renderMarkdown } from '../../../webview/markdown-render.ts';
import { parseMarkdown } from '../../../webview/markdown.ts';
import { LIMITS } from '../messages.ts';
import { lineSegments, type BoardView, type BodyLineView, type CardView, type LaneView, type Segment, type ViewStrings } from '../view.ts';
import { foldedLabel } from './body-folds.ts';
import type { CardMenuEntry, LaneChoice } from './card-menu.ts';

export interface RenderState {
  /** Lanes the user collapsed or expanded in this session, overriding list-collapse. */
  readonly collapsed: ReadonlyMap<number, boolean>;
  /** Whether a card's body is folded (kanban.md 3.2); default: the board's cardBodies. */
  readonly folded?: (card: CardView) => boolean;
}

/**
 * Display segments of one line (kanban.md 3) as text nodes and elements; a run of
 * `highlight` segments (==...==) becomes one <mark>. Wikilinks carry the open-link hook;
 * `focusableLinks: false` keeps them out of the tab order (the card preview, kanban.md 3.3).
 * With `pickLabel`, the card's first date badge (`pick`) is a button that opens the date
 * picker (kanban.md 4.8), named by that label.
 */
export function renderSegments<E extends DomElement<E>>(
  doc: DomDocument<E>,
  list: readonly Segment[],
  focusableLinks = true,
  pickLabel?: string,
): (E | string)[] {
  const el = createElementFactory(doc);
  const segment = (seg: Segment): E | string => {
    switch (seg.kind) {
      case 'text':
        return seg.text;
      case 'bold':
        return el('strong', { text: seg.text });
      case 'italic':
        return el('em', { text: seg.text });
      case 'code':
        return el('code', { text: seg.text });
      case 'wikilink':
        return el('span', {
          className: 'wikilink',
          text: seg.text,
          attrs: { role: 'link', tabindex: focusableLinks ? '0' : '-1', 'data-action': 'open-link', 'data-target': seg.target, title: seg.target },
        });
      case 'tag':
        return el('span', { className: 'badge tag', text: seg.text });
      case 'date': {
        const pick = seg.pick === true && pickLabel !== undefined;
        return el('span', {
          className: `badge date date-${seg.state}${pick ? ' date-pick' : ''}`,
          text: seg.text,
          attrs: {
            'data-date': seg.iso,
            ...(pick
              ? { role: 'button', tabindex: '0', 'data-action': 'pick-date', 'aria-haspopup': 'dialog', title: pickLabel, 'aria-label': `${seg.text}, ${pickLabel}` }
              : {}),
          },
        });
      }
      case 'time':
        return el('span', { className: 'badge time', text: seg.text });
      case 'category':
        return el('span', { className: 'badge category', text: seg.text });
      case 'link':
        return el('span', { className: 'md-link', text: seg.text });
    }
  };

  const out: (E | string)[] = [];
  let run: (E | string)[] | undefined;
  const flush = (): void => {
    if (run) out.push(el('mark', { className: 'highlight' }, ...run));
    run = undefined;
  };
  for (const seg of list) {
    if (seg.highlight === true) {
      (run ??= []).push(segment(seg));
    } else {
      flush();
      out.push(segment(seg));
    }
  }
  flush();
  return out;
}

/** The card's body as Markdown: the edit text (kanban.md 4.4) after the title line. */
export function bodyMarkdown(card: CardView): string {
  const at = card.editText.indexOf('\n');
  return at < 0 ? '' : card.editText.slice(at + 1);
}

/** Offset of the first `token` in `text` that starts the text or follows whitespace, as Obsidian finds the card date. */
function tokenAt(text: string, token: string): number | undefined {
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    if (at === 0 || /\s/.test(text[at - 1]!)) return at;
  }
  return undefined;
}

/**
 * The card body drawn as Markdown (kanban.md 3; the preview, 3.3): the shared Markdown display
 * with the board's token rules in plain text, table cells beyond the header kept, links inert,
 * checkboxes disabled, no HTML. With `pickLabel`, when the card's first date token is in the
 * body (a body line carries the pick badge), its first badge in the drawn text opens the date
 * picker (4.8).
 */
export function renderBodyMarkdown<E extends DomElement<E>>(
  doc: DomDocument<E>,
  view: BoardView,
  card: CardView,
  focusableLinks: boolean,
  pickLabel?: string,
): E {
  const ctx = { dateFormat: view.dateFormat, today: view.today, dateTrigger: view.dateTrigger, timeTrigger: view.timeTrigger };
  const inBody = card.body.some((line) => line.segments.some((seg) => seg.kind === 'date' && seg.pick === true));
  let pending = pickLabel !== undefined && inBody ? card.date?.token : undefined;
  return renderMarkdown(doc, parseMarkdown(bodyMarkdown(card), { extraCells: true, highlight: true }), {
    headingOffset: 2,
    openLinks: false,
    text: (text) => {
      const at = pending === undefined ? undefined : tokenAt(text, pending);
      const segments = lineSegments(text, ctx, false, at);
      if (at !== undefined && segments.some((seg) => seg.kind === 'date' && seg.pick === true)) pending = undefined;
      return renderSegments(doc, segments, focusableLinks, pickLabel);
    },
  });
}

/** The width slider's value text and tooltip for a width in px (kanban.md 4.10). */
export function laneWidthText(s: ViewStrings, width: number): { 'aria-valuetext': string; title: string } {
  const px = String(Math.round(width * 10) / 10);
  return { 'aria-valuetext': s.laneWidthValue.replace('{0}', px), title: s.laneWidthTitle.replace('{0}', px) };
}

export function renderBoard<E extends DomElement<E>>(doc: DomDocument<E>, view: BoardView, state: RenderState): E {
  const el = createElementFactory(doc);
  const s = view.strings;
  const segments = (list: readonly Segment[]): (E | string)[] => renderSegments(doc, list, true, s.changeDate);

  const bodyLine = (line: BodyLineView): E =>
    el('div', { className: `body-line depth-${line.depth}${line.code ? ' code' : ''}` }, ...segments(line.segments));

  const isFolded = state.folded ?? ((c: CardView) => view.cardBodies === 'collapsed' && c.body.length > 0);

  /**
   * The body below the title, or for a folded body a one-line marker with the line count.
   * The toggle is the same thin chevron as the lane collapse, in the checkbox column.
   */
  const body = (c: CardView): E[] => {
    if (c.body.length === 0) return [];
    const folded = isFolded(c);
    const label = folded ? s.expandBody : s.collapseBody;
    const toggle = el(
      'button',
      {
        className: 'body-toggle',
        attrs: { type: 'button', 'data-action': 'toggle-body', 'aria-expanded': String(!folded), 'aria-label': label, title: label, tabindex: '-1' },
      },
      el('span', { className: 'body-toggle-icon', text: '›', attrs: { 'aria-hidden': 'true' } }),
    );
    if (folded) {
      const marker = el('span', { className: 'body-folded-label', text: `⋯ ${foldedLabel(c.body.length, s.bodyLines, s.bodyLine)}` });
      return [toggle, el('div', { className: 'card-body folded', attrs: { 'data-action': 'toggle-body', title: s.expandBody } }, marker)];
    }
    // Markdown blocks (kanban.md 3); line by line when a line is over the 2.10 limits.
    if (c.plainBody === true) return [toggle, el('div', { className: 'card-body' }, ...c.body.map(bodyLine))];
    return [toggle, el('div', { className: 'card-body card-body-md' }, renderBodyMarkdown(doc, view, c, true, s.changeDate))];
  };

  const card = (lane: LaneView, c: CardView): E => {
    const ids = { 'data-lane': String(lane.id.laneIndex), 'data-card': String(c.id.cardIndex) };
    // Without check boxes (kanban.md 2.9) the column stays for the body toggle; Space still toggles.
    const checkbox = view.showCheckboxes
      ? el('input', {
          className: 'card-check',
          attrs: { type: 'checkbox', 'data-action': 'toggle', 'aria-label': s.toggleCard, tabindex: '-1', ...(c.checked ? { checked: '' } : {}) },
        })
      : el('span', { className: 'card-check-space', attrs: { 'aria-hidden': 'true' } });
    return el(
      'li',
      {
        className: `card${c.checked ? ' checked' : ''}${c.body.length > 0 ? ' has-body' : ''}${isFolded(c) ? ' body-folded' : ''}`,
        attrs: { ...ids, draggable: 'true', tabindex: '0', 'data-drag': 'card' },
      },
      checkbox,
      el('div', { className: 'card-title', attrs: { 'data-action': 'edit-card', title: s.editCard } }, ...segments(c.segments)),
      // Card menu (kanban.md 4.6): shown on hover or selection; Shift+F10 opens it from the keyboard.
      el('button', {
        className: 'card-menu-button',
        text: '⋯',
        attrs: { type: 'button', 'data-action': 'card-menu', 'aria-label': s.cardMenu, title: s.cardMenu, 'aria-haspopup': 'menu', tabindex: '-1' },
      }),
      ...body(c),
    );
  };

  /**
   * Lane fold toggle (kanban.md 3.2): only in a lane with card bodies, and not while the lane
   * is collapsed (its cards are hidden). Folds every body when any is expanded, else unfolds
   * them all; the label and the double chevron (up: fold, down: unfold) name that next action.
   */
  const laneBodies = (l: LaneView, collapsed: boolean): E[] => {
    const withBody = l.cards.filter((c) => c.body.length > 0);
    if (collapsed || withBody.length === 0) return [];
    const next = withBody.some((c) => !isFolded(c)) ? 'fold' : 'unfold';
    const label = next === 'fold' ? s.collapseLaneBodies : s.expandLaneBodies;
    return [
      el(
        'button',
        { className: 'lane-bodies', attrs: { type: 'button', 'data-action': 'toggle-lane-bodies', 'data-next': next, 'aria-label': label, title: label } },
        el('span', { className: 'lane-bodies-icon', attrs: { 'aria-hidden': 'true' } }),
      ),
    ];
  };

  const lane = (l: LaneView): E => {
    const index = String(l.id.laneIndex);
    const collapsed = state.collapsed.get(l.id.laneIndex) ?? l.collapsed;
    const header = el(
      'header',
      { className: 'lane-header', attrs: { draggable: 'true', 'data-drag': 'lane', 'data-lane': index } },
      // One thin chevron, turned by CSS: right when collapsed, down when expanded.
      el(
        'button',
        {
          className: 'lane-collapse',
          attrs: { type: 'button', 'data-action': 'collapse', 'aria-expanded': String(!collapsed), 'aria-label': collapsed ? s.expand : s.collapse },
        },
        el('span', { className: 'lane-collapse-icon', text: '›', attrs: { 'aria-hidden': 'true' } }),
      ),
      el('h2', {
        className: 'lane-title',
        text: l.name,
        // A collapsed title is cut with an ellipsis; the tooltip keeps the full name.
        attrs: { tabindex: '0', 'data-action': 'rename-lane', title: collapsed ? `${l.name} — ${s.renameLane}` : s.renameLane },
      }),
      ...(l.done ? [el('span', { className: 'lane-done', text: '✓', attrs: { role: 'img', 'aria-label': s.done, title: s.done } })] : []),
      el('span', { className: 'lane-count', text: String(l.cards.length) }),
      ...laneBodies(l, collapsed),
    );
    return el(
      'section',
      { className: `lane${l.done ? ' done' : ''}${collapsed ? ' collapsed' : ''}`, attrs: { 'data-lane': index, 'aria-label': l.name } },
      header,
      el('ul', { className: 'cards', attrs: { 'data-lane': index, ...(collapsed ? { hidden: '' } : {}) } }, ...l.cards.map((c) => card(l, c))),
      el('button', {
        className: 'add-card',
        text: `+ ${s.addCard}`,
        attrs: { type: 'button', 'data-action': 'add-card', 'data-lane': index, ...(collapsed ? { hidden: '' } : {}) },
      }),
    );
  };

  const notices: E[] = [];
  if (!view.isBoard) notices.push(el('p', { className: 'notice', text: s.notABoard }));
  if (view.lanes.length === 0) notices.push(el('p', { className: 'notice', text: s.noLanes }));

  return el(
    'div',
    { className: 'board-root' },
    ...notices,
    // Keyboard help stays out of the way: a "?" that reveals the text on hover or focus.
    el(
      'div',
      { className: 'board-toolbar' },
      // Width slider (kanban.md 4.10): previews while dragged, main.ts writes lane-width when it is let go.
      ...(view.laneWidthSlider
        ? [
            el('input', {
              className: 'board-lane-width',
              attrs: {
                type: 'range',
                min: String(LIMITS.laneWidthMin),
                max: String(LIMITS.laneWidthMax),
                step: String(LIMITS.laneWidthStep),
                value: String(view.laneWidth),
                'aria-label': s.laneWidth,
                ...laneWidthText(s, view.laneWidth),
              },
            }),
          ]
        : []),
      // Check box switch (kanban.md 4.9): writes the board's show-checkboxes, so only with a readable settings block.
      ...(view.checkboxSwitch
        ? [
            el(
              'button',
              {
                className: 'board-checkboxes',
                attrs: {
                  type: 'button',
                  'data-action': 'toggle-checkboxes',
                  'aria-pressed': String(view.showCheckboxes),
                  'aria-label': s.showCheckboxes,
                  title: s.showCheckboxes,
                },
              },
              el('span', { className: 'board-checkboxes-icon', text: view.showCheckboxes ? '✓' : '', attrs: { 'aria-hidden': 'true' } }),
            ),
          ]
        : []),
      el(
        'button',
        {
          className: 'board-help',
          attrs: { type: 'button', 'aria-label': s.keyboardHelpLabel, 'aria-describedby': 'board-help-text' },
        },
        el('span', { className: 'board-help-icon', text: '?', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'board-help-text', text: s.keyboardHelp, attrs: { id: 'board-help-text', role: 'tooltip' } }),
      ),
    ),
    el('div', { className: 'board' }, ...view.lanes.map(lane)),
  );
}

/**
 * Multi-line card editor (kanban.md 4.4): a textarea holding the whole card as edit text.
 * The initial value goes in as textContent, never as markup. Height follows the content
 * (main.ts grows it while typing).
 */
export function renderCardEditor<E extends DomElement<E>>(doc: DomDocument<E>, card: CardView, strings: ViewStrings): E {
  const el = createElementFactory(doc);
  const rows = Math.min(Math.max(card.editText.split('\n').length, 1), 12);
  return el('textarea', {
    className: 'inline-edit card-editor',
    text: card.editText,
    attrs: { 'aria-label': strings.editCard, rows: String(rows), maxlength: String(LIMITS.cardText), spellcheck: 'false' },
  });
}

/**
 * Card menu (kanban.md 4.6): role=menu with menuitem rows; text only. `data-index` is the
 * entry's position in `entries` (separators included) so main.ts can map clicks back.
 */
export function renderCardMenu<E extends DomElement<E>>(
  doc: DomDocument<E>,
  entries: readonly CardMenuEntry[],
  label: string,
): E {
  const el = createElementFactory(doc);
  return el(
    'div',
    { className: 'card-menu', attrs: { role: 'menu', 'aria-label': label, tabindex: '-1' } },
    ...entries.map((entry, i) => {
      if (entry.kind === 'separator') return el('div', { className: 'card-menu-separator', attrs: { role: 'separator' } });
      return el(
        'div',
        {
          className: `card-menu-item${entry.danger ? ' danger' : ''}`,
          attrs: {
            role: 'menuitem',
            tabindex: '-1',
            'data-index': String(i),
            'data-item': entry.id,
            ...(entry.disabled ? { 'aria-disabled': 'true' } : {}),
            ...(entry.submenu ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
            // ARIA names the Ctrl modifier "Control".
            ...(entry.keybinding ? { 'aria-keyshortcuts': entry.keybinding.replace(/^Ctrl\+/, 'Control+') } : {}),
          },
        },
        el('span', { className: 'card-menu-label', text: entry.label }),
        ...(entry.keybinding ? [el('span', { className: 'card-menu-keybinding', text: entry.keybinding, attrs: { 'aria-hidden': 'true' } })] : []),
        ...(entry.submenu ? [el('span', { className: 'card-menu-chevron', text: '›', attrs: { 'aria-hidden': 'true' } })] : []),
      );
    }),
  );
}

/** "Move to lane" list: lane names; done lanes get a check mark, the card's lane is disabled. */
export function renderLaneMenu<E extends DomElement<E>>(
  doc: DomDocument<E>,
  choices: readonly LaneChoice[],
  label: string,
  doneLabel: string,
): E {
  const el = createElementFactory(doc);
  return el(
    'div',
    { className: 'card-menu card-submenu', attrs: { role: 'menu', 'aria-label': label, tabindex: '-1' } },
    ...choices.map((choice, i) =>
      el(
        'div',
        {
          className: 'card-menu-item',
          attrs: {
            role: 'menuitem',
            tabindex: '-1',
            'data-index': String(i),
            'data-lane': String(choice.lane),
            ...(choice.current ? { 'aria-disabled': 'true' } : {}),
          },
        },
        el('span', { className: 'card-menu-label', text: choice.name }),
        ...(choice.done
          ? [el('span', { className: 'card-menu-done', text: '✓', attrs: { role: 'img', 'aria-label': doneLabel } })]
          : []),
      ),
    ),
  );
}
