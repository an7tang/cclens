'use strict';
/**
 * Where cclens keeps its data.
 *
 * Everything lives under ~/.claude/cclens, inside Claude Code's own directory rather than a separate
 * ~/.cclens, so that backing up or moving ~/.claude carries the recordings with it — the data is *about*
 * Claude Code, and keeping it somewhere else means a migration silently leaves the history behind.
 * (~/.claude already hosts other tools' directories, so this follows an existing convention.)
 *
 * That placement has one hazard worth engineering against rather than documenting: ~/.claude is commonly
 * kept under version control for settings.json, CLAUDE.md, agents/, skills/ and commands/. Captured
 * traffic is plaintext prompts, code and responses, so landing it inside a dotfiles repo would be a real
 * leak. ensureHome() therefore seeds a .gitignore that excludes the whole directory, which makes a stray
 * `git add -A` in ~/.claude a no-op for our data instead of a disclosure.
 *
 * CCLENS_HOME relocates all of it at once. The narrower CCLENS_DATA / CCLENS_HOOKS_DATA /
 * CCLENS_TRANSCRIPTS still win for their own layer — pointing one at an empty directory is how a single
 * layer is hidden for one run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.CCLENS_HOME || path.join(os.homedir(), '.claude', 'cclens');

// Where earlier versions kept everything. Nothing reads it any more; status names it if it is still
// there, so an upgrade does not silently look like the history vanished.
const LEGACY_HOME = path.join(os.homedir(), '.cclens');

// `!.gitignore` keeps this file itself committable: if ~/.claude is a dotfiles repo, the guard then
// travels with a fresh clone and protects the directory before cclens has ever run on that machine.
const GITIGNORE = `# cclens recordings: plaintext prompts, code and API responses.
# ~/.claude is often a dotfiles repo, so this directory excludes itself from it.
*
!.gitignore
`;

/** Create the data home if needed, and make sure it cannot be committed by accident. */
function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  const gi = path.join(HOME, '.gitignore');
  // Written once and left alone afterwards, so an edited copy is never clobbered
  if (!fs.existsSync(gi)) {
    try { fs.writeFileSync(gi, GITIGNORE); } catch { /* a missing .gitignore must not stop cclens working */ }
  }
  return HOME;
}

/**
 * Create a directory that will hold recorded data, seeding the guard first when it sits under HOME.
 * Every writer must come through here rather than calling mkdirSync itself: whichever of them runs first
 * on a new machine is the one that creates HOME, and if it skipped the .gitignore the data would be
 * exposed until something else happened to seed it. The hook recorder in particular often runs first,
 * and its UserPromptSubmit payloads carry prompt text.
 */
function ensureDataDir(dir) {
  const inside = !path.relative(HOME, dir).startsWith('..');
  if (inside) ensureHome();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dataDir = () => process.env.CCLENS_DATA || path.join(HOME, 'data');
const hooksDir = () => process.env.CCLENS_HOOKS_DATA || path.join(HOME, 'hooks');
const configFile = () => path.join(HOME, 'config.json');

/** The legacy home, only if it still exists and is not the one in use — otherwise null. */
function legacyHome() {
  if (HOME === LEGACY_HOME) return null;
  try { return fs.statSync(LEGACY_HOME).isDirectory() ? LEGACY_HOME : null; } catch { return null; }
}

module.exports = { HOME, LEGACY_HOME, ensureHome, ensureDataDir, dataDir, hooksDir, configFile, legacyHome };
