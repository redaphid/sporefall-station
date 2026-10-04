import fs from 'node:fs'
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const cols = ['cond', 'path', 'via', 'rttP50', 'rttP95', 'rttP99', 'owdP50', 'owdP95', 'owdMax', 'jitterSd', 'jitterP95', 'gapP95', 'gapMax', 'snapLossPct', 'reordered', 'rttN', 'pingsSent']
console.log(cols.join('\t'))
for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'))
