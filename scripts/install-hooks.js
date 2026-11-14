// Añade (o quita con --remove) los hooks de Claude Code que avisan a Glass Island.
const hooks = require('../hooks');

const remove = process.argv.includes('--remove');
const result = hooks.set(!remove);
if (result.error) { console.error(result.error); process.exit(1); }
console.log(`${remove ? 'Hooks eliminados de' : 'Hooks instalados en'} ${result.file}`);
