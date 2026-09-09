/**
 * Keyword -> skill routing table for the UserPromptSubmit hook.
 *
 * This exists because muse skills are explicit-invocation only: the harness never
 * fires a skill just because a task looks complex, and skill frontmatter has no
 * `triggers` field (muse's frontmatter profile knows only name/description/
 * allowed-tools). So the only way to get oh-my-claudecode's keyword routing is a
 * hook that recognises the word and *suggests* the skill.
 *
 * The hook suggests; it never invokes. Invocation stays the user's.
 */

/** @type {ReadonlyArray<{ skill: string, keywords: readonly string[] }>} */
export const ROUTES = Object.freeze([
  { skill: 'deep-interview', keywords: ['deep-interview', 'deep interview', 'interview me'] },
  { skill: 'deep-dive', keywords: ['deep-dive', 'deep dive', 'investigate deeply'] },
  { skill: 'trace', keywords: ['trace', 'root cause', 'root-cause'] },
  { skill: 'ralplan', keywords: ['ralplan'] },
  { skill: 'ralph', keywords: ['ralph'] },
  { skill: 'team', keywords: ['team mode', 'fan out', 'fan-out'] },
  { skill: 'cancel', keywords: ['cancelomm', 'cancel omm'] },
]);

/**
 * Word-boundary match so "ralph" hits but "ralphie" and "ethnography" do not.
 * Keywords containing spaces are matched as phrases.
 *
 * `/`, `.` and `_` count as word characters here, not boundaries, so a file path
 * like `lib/ralph.js` or `src/trace_test.py` does not read as a request to run the
 * skill. Someone naming a path is talking about code, not asking for a pipeline.
 * Explicit `/ralph` invocations are handled separately by matchesSlashCommand.
 *
 * @param {string} prompt
 * @param {string} keyword
 * @returns {boolean}
 */
function matchesKeyword(prompt, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._/-])${escaped}([^a-z0-9._/-]|$)`, 'i').test(prompt);
}

/**
 * Matches an explicit slash invocation such as `/cancel` or `/ralph`.
 *
 * This is the high-precision path, and it is the ONLY way some skills can be
 * routed. `cancel` is the clearest case: the bare word is far too common in
 * ordinary English ("cancel that subscription", "how do I cancel a promise") to
 * route on, and cancellation discards in-flight state, so a false positive is
 * expensive. Requiring the slash keeps the routing safe without dropping the
 * skill from the table.
 *
 * @param {string} prompt
 * @param {string} skill
 * @returns {boolean}
 */
function matchesSlashCommand(prompt, skill) {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)/${escaped}([^a-z0-9-]|$)`, 'i').test(prompt);
}

/**
 * Returns the skill ids suggested by a prompt, in ROUTES order, without duplicates.
 *
 * @param {string} prompt
 * @returns {string[]}
 */
export function routePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return [];

  const hits = [];
  for (const { skill, keywords } of ROUTES) {
    const matched =
      matchesSlashCommand(prompt, skill) ||
      keywords.some((keyword) => matchesKeyword(prompt, keyword));
    if (matched) hits.push(skill);
  }
  return hits;
}

/**
 * Renders the additional context emitted for matched skills, or null when nothing
 * matched. Returning null (rather than an empty string) keeps the caller honest
 * about the "stay silent" path.
 *
 * @param {string[]} skills
 * @returns {string | null}
 */
export function renderRoutingContext(skills) {
  if (skills.length === 0) return null;

  const lines = skills.map((skill) => `  - /${skill}`);
  return [
    'oh-my-musecode: this prompt mentions a skill that is available in this workspace.',
    'muse skills are invoke-only, so nothing has been run. Suggested:',
    ...lines,
    '',
    'Invoke one explicitly to load its instructions for that turn.',
  ].join('\n');
}
