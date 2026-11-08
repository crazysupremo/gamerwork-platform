// moderation.js
// Filtro de texto por palavras-chave/expressões de risco.
// IMPORTANT: Isto é um filtro de TRIAGEM (sinaliza/bloqueia), não uma detecção
// certificada de CSAM. Detecção real de CSAM exige hash-matching contra bancos
// como o do NCMEC (via PhotoDNA/Thorn Safer), disponível apenas para empresas
// registradas — ver README.md.

// Categorias de risco. Termos genéricos de sinalização, sem qualquer conteúdo
// instrutivo. Cada mensagem enviada é comparada (case-insensitive, ignorando
// acentos) contra estas listas.
const FLAG_CATEGORIES = {
  armas_venda: [
    'vender arma', 'venda de arma', 'comprar arma ilegal', 'arma sem registro',
    'pistola a venda', 'fuzil a venda', 'trafico de arma', 'tráfico de armas',
    'sell a gun', 'buy illegal gun', 'gun for sale', 'firearm for sale',
  ],
  explosivos: [
    'como fazer bomba', 'como fazer explosivo', 'fabricar bomba', 'fabricar explosivo',
    'construir uma bomba', 'receita de bomba', 'how to make a bomb',
    'how to build a bomb', 'bomb instructions', 'explosive recipe',
  ],
  violencia_grave: [
    'como matar', 'contratar assassino', 'assassino de aluguel', 'matar alguem',
    'matar alguém', 'hire a hitman', 'how to kill', 'kill someone',
  ],
  exploracao_infantil: [
    'pornografia infantil', 'conteudo infantil sexual', 'conteúdo infantil sexual',
    'nudes de menor', 'nudes menor de idade', 'csam', 'child porn',
    'cp links', 'menor nu', 'sexualizar crianca', 'sexualizar criança',
  ],
  conteudo_sexual_explicito: [
    'link porno', 'video pornografico', 'vídeo pornográfico', 'conteudo pornografico',
    'conteúdo pornográfico', 'porn link', 'nudes',
  ],
};

// Achata tudo em uma única lista com a categoria associada.
const FLAT_TERMS = Object.entries(FLAG_CATEGORIES).flatMap(([category, terms]) =>
  terms.map((term) => ({ category, term: normalize(term) }))
);

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // remove acentos
}

// Categorias que resultam em BLOQUEIO automático da mensagem (não apenas alerta).
// Ajustado para que TODAS as categorias de risco sejam bloqueadas (nenhuma
// fica só "sinalizada" sem ação) — inclui também conteúdo_sexual_explicito.
const AUTO_BLOCK_CATEGORIES = new Set(Object.keys(FLAG_CATEGORIES));

/**
 * Analisa um texto e retorna as categorias de risco encontradas.
 * @param {string} text
 * @returns {{ flagged: boolean, block: boolean, categories: string[] }}
 */
function scanText(text) {
  if (!text || typeof text !== 'string') {
    return { flagged: false, block: false, categories: [] };
  }
  const normalized = normalize(text);
  const hits = FLAT_TERMS.filter(({ term }) => normalized.includes(term));
  const categories = [...new Set(hits.map((h) => h.category))];
  const block = categories.some((c) => AUTO_BLOCK_CATEGORIES.has(c));
  return { flagged: categories.length > 0, block, categories };
}

module.exports = { scanText, FLAG_CATEGORIES, AUTO_BLOCK_CATEGORIES };
