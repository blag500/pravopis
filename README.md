# pravopis — български правопис за Claude Code

Скил за [Claude Code](https://claude.com/claude-code), който проверява и поправя българския правопис
и пунктуация в сайтове, приложения и документи.

- **Скрипт** (`scripts/check.mjs`) хваща механичните грешки: „в/във“, „с/със“, „ѝ“, кавички „…“,
  тире срещу дефис, хиляди и десетична запетая, интервал преди €, пълен член след предлог,
  „по-/най-“, „не“ с глагол, запетая в „въпреки че“ — и думите, които ги няма в речника.
- **Правила** (`references/pravila.md`) по Официалния правописен речник на Института за български
  език при БАН водят прочита на Claude за останалото: членуване по роля, запетаи, бройна форма.

## Инсталиране

```bash
git clone <този repo> ~/.claude/skills/pravopis
cd ~/.claude/skills/pravopis && npm install
```

След това в Claude Code: „провери правописа в src/“ или `/pravopis`.

Скриптът работи и сам:

```bash
node ~/.claude/skills/pravopis/scripts/check.mjs src/ docs/plan.docx
```

## Речникът

При първото пускане скриптът сваля българския hunspell речник на проекта
[bgoffice](https://bgoffice.sourceforge.net) от
[LibreOffice/dictionaries](https://github.com/LibreOffice/dictionaries/tree/master/bg_BG)
в `~/.cache/pravopis`. Речникът е под GPL и не е част от това repo.

## Лиценз

MIT — за кода и правилата.
