// Steam's Field rows each draw as their own padded card, with toggles inset differently
// from buttons, which reads as ragged in a panel this narrow; so the panel lays itself
// out and keeps Steam's own buttons and toggles for the controls. Colours are Steam's
// own variables, so they follow its theme
export const PANEL_CSS = `
.epic-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 16px;
  color: var(--gpSystemLighterGrey, #dcdedf);
  font-size: 13px;
  line-height: 1.4;
  /* Steam's light grey nudged toward its lighter one: on the cards' raised
     background the plain light grey falls just short of 4.5:1 at 12px. */
  --epic-dim: color-mix(
    in srgb,
    var(--gpSystemLightGrey, #8b929a) 75%,
    var(--gpSystemLighterGrey, #dcdedf)
  );
}

.epic-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.epic-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.epic-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--gpSystemDarkGrey, #3d4450);
  color: var(--gpColor-White, #fff);
  font-size: 17px;
  font-weight: 600;
}

.epic-identity-text {
  min-width: 0;
}

.epic-title {
  overflow: hidden;
  color: var(--gpColor-White, #fff);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epic-dim {
  color: var(--epic-dim);
  font-size: 12px;
}

/* Steam exposes no red variable, so a fixed one, light enough for 4.5:1 on the cards. */
.epic-error {
  color: #ff7b72;
  font-size: 12px;
}

.epic-meter-label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--epic-dim);
  font-size: 12px;
}

.epic-meter-label strong {
  color: var(--gpSystemLighterGrey, #dcdedf);
  font-weight: 500;
}

.epic-meter {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
}

.epic-meter-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--gpColor-Blue, #1a9fff);
  transition: width 0.3s ease-out;
}

.epic-busy > svg {
  width: 1em;
  height: 1em;
  margin-right: 8px;
  vertical-align: -0.125em;
}

/* Two equal columns, so buttons line up whatever their labels; a wide one takes a row */
.epic-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.epic-actions > * {
  width: 100%;
  min-width: 0;
  margin: 0;
  padding-left: 12px;
  padding-right: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.epic-actions > .epic-wide {
  grid-column: 1 / -1;
}

/* Ko-fi's red, so the one button that isn't about the library reads as such.
   Darker than Ko-fi's own #ff5e5b, which only reaches 3:1 under white text. */
.epic-actions > .epic-kofi {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #d63c39;
  color: #fff;
}

.epic-actions > .epic-kofi:hover,
.epic-actions > .epic-kofi.gpfocus {
  background: #c2302d;
  color: #fff;
}

/* Replacing Steam's focus background leaves only a shade change, so add a ring. */
.epic-actions > .epic-kofi.gpfocus {
  outline: 2px solid var(--gpColor-White, #fff);
  outline-offset: 2px;
}

.epic-heading {
  margin: 0 2px 8px;
  color: var(--epic-dim);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.epic-list {
  overflow: hidden;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.epic-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 16px;
  box-sizing: border-box;
}

.epic-row + .epic-row {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.epic-row-text {
  flex: 1;
  min-width: 0;
}

.epic-row-control {
  flex: none;
}
`;
