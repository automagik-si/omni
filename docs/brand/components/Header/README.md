# Header

The site's top bar: the logo, the three menus and one small primary button. It stays at the top of every page, on a see-through `bg` with a `line` under it.

- The logo is the lockup with the three-colour triskle, in its **header drawing** (the files ending `-header`): ink letters on the light theme, cream letters on the dark one. Shown here 38px high, as on the site (31px at 700px wide and under, 28.5px at 360px and under). Never set it under 28px high.
- It points at one file per theme. When the wordmark changes, replace those files under the same names; nothing here changes.
- Menu buttons use `label-nav`. The current section's button carries `data-here` and sits on `bt-active`.
- Under 860px wide the three menus are hidden. On the site the family drawer holds their links then: it opens from a round button at the bar's left, at every width. The drawer is a piece of its own (the site's `assets/family/`), not part of this folder, so this preview leaves its button out.
- The bar is 72px high (64px on a phone); the site keeps that in `--top-h` on `.top`.
