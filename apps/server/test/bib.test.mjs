/**
 * BibTeX fields as Cite and the \cite autocomplete show them. Braces came
 * off before commands, so {\TeX}book read as one unknown command and the
 * title shrank to "The"; accents printed as \"u.
 */
import { check, eq } from './assert.mjs';
const { parseBib } = await import('../src/bib.ts');

const one = (fields) => parseBib(`@book{k,\n${fields}\n}`, 'refs.bib')[0];
const title = (t) => one(`  title = {${t}},`).title;

eq(title('The {\\TeX}book'), 'The TeXbook', 'a braced logo keeps the word it starts');
eq(title('{\\LaTeX}: A Document Preparation System'), 'LaTeX: A Document Preparation System', 'a leading logo stays');
eq(title('The \\LaTeX\\ Companion'), 'The LaTeX Companion', 'a control space is a space');
eq(title('\\TeX book'), 'TeXbook', 'a control word eats the spaces after it, as in TeX');
eq(title('\\emph{Drosophila} genetics'), 'Drosophila genetics', 'a formatting command keeps its argument');
eq(title('Rock \\& Roll at 100\\%'), 'Rock & Roll at 100%', 'escaped specials print');
eq(title('The set \\{a, b\\}'), 'The set {a, b}', 'escaped braces stay');
eq(title('$\\beta$-decay and $k$-means'), 'β-decay and k-means', 'inline math loses its dollars, Greek prints');
eq(title('Theory --- and practice, 1990--2000'), 'Theory — and practice, 1990–2000', 'dashes');
eq(title('``Quoted\'\' words'), '“Quoted” words', 'TeX quotes');
eq(title('On {\\v{C}}ech, Erd\\H{o}s and Fran\\c{c}ois'), 'On Čech, Erdős and François', 'letter accents');
eq(title('Ra\\\'{\\i}z, {\\\'E}mile, Bj{\\o}rn, \\L{}ukasz, Stra\\ss e'), 'Raíz, Émile, Bjørn, Łukasz, Straße', 'symbol accents and special letters');
eq(title('\\cite and \\url{x} and \\Huge y'), 'and x and y', 'commands that start like accents stay commands');

const e = one('  author = {M{\\"u}ller, J{\\"o}rg and Ga{\\ss}ner, Anna},\n  title = {T},');
eq(e.author, 'Müller, Jörg and Gaßner, Anna', 'accented authors');
eq(e.authorLabel, 'Müller', 'the first author label is accented too');
eq(one('  author = {{Growth Market Reports}},').authorLabel, 'Growth Market Reports', 'a literal name stays whole');
eq(one('  author = {Castanon Remy, Jean},').authorLabel, 'Castanon Remy', 'a comma-form surname keeps every word');
eq(one('  title = "Quoted \\TeX{} field",').title, 'Quoted TeX field', 'a quoted field cleans the same way');
check(one('  year = {2020},').title === undefined, 'a missing title stays missing');

// unbraced values: a number, or a macro from @string
const [bare] = parseBib('@string{jacm = {Journal of the {ACM}}}\n@article{b,\n  title = {T},\n  year = 2020,\n  journal = JACM\n}', 'refs.bib');
eq(bare.year, '2020', 'an unbraced year');
eq(bare.journal, 'Journal of the ACM', 'a journal from an @string macro');
check(one('  title = {T},\n  journal = nosuchmacro').journal === undefined, 'an undefined macro is no journal');

console.log('bib: ok');
