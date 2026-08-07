// Parser de linguagem livre em português para eventos da agenda.
// Reconhece datas (hoje, amanhã, depois de amanhã, dia da semana, DD/MM)
// e horários (14h, 14:30, "das 8 às 9h30"), e usa o restante do texto como título.

const DIAS_SEMANA = [
  ['domingo', 0],
  ['segunda-feira', 1], ['segunda', 1],
  ['terça-feira', 2], ['terca-feira', 2], ['terça', 2], ['terca', 2],
  ['quarta-feira', 3], ['quarta', 3],
  ['quinta-feira', 4], ['quinta', 4],
  ['sexta-feira', 5], ['sexta', 5],
  ['sábado', 6], ['sabado', 6],
];

// \b padrão do JS não entende acentos (ã, ç, á...) como letra, então usamos
// lookaround com \p{L}/\p{N} pra ter um "boundary" que funciona em português.
function palavra(padrao) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${padrao})(?![\\p{L}\\p{N}])`, 'iu');
}

function spHoje() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(new Date());
  const y = +parts.find(p => p.type === 'year').value;
  const m = +parts.find(p => p.type === 'month').value;
  const d = +parts.find(p => p.type === 'day').value;
  return { y, m, d, utcMidnight: Date.UTC(y, m - 1, d) };
}

function isoDate(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDate(textLower, hoje) {
  let m = textLower.match(palavra('depois de amanh[ãa]'));
  if (m) return { data: isoDate(hoje.utcMidnight + 2 * 86400000), match: m[0] };

  m = textLower.match(palavra('amanh[ãa]'));
  if (m) return { data: isoDate(hoje.utcMidnight + 1 * 86400000), match: m[0] };

  m = textLower.match(palavra('hoje'));
  if (m) return { data: isoDate(hoje.utcMidnight), match: m[0] };

  m = textLower.match(/(?:dia\s+)?\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    const anoInformado = !!m[3];
    let yyyy = anoInformado ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : hoje.y;
    let dt = Date.UTC(yyyy, mm - 1, dd);
    if (!anoInformado && dt < hoje.utcMidnight) dt = Date.UTC(yyyy + 1, mm - 1, dd);
    return { data: isoDate(dt), match: m[0] };
  }

  m = textLower.match(/\bdia (\d{1,2})\b/);
  if (m) {
    const dd = +m[1];
    let dt = Date.UTC(hoje.y, hoje.m - 1, dd);
    if (dt < hoje.utcMidnight) dt = Date.UTC(hoje.y, hoje.m, dd);
    return { data: isoDate(dt), match: m[0] };
  }

  for (const [nome, alvo] of DIAS_SEMANA) {
    const mm = textLower.match(palavra(nome));
    if (mm) {
      const hojeSemana = new Date(hoje.utcMidnight).getUTCDay();
      let diff = (alvo - hojeSemana + 7) % 7;
      if (diff === 0) diff = 7;
      return { data: isoDate(hoje.utcMidnight + diff * 86400000), match: mm[0] };
    }
  }

  return null;
}

function extractTime(textLower) {
  let m = textLower.match(/(?:das|de)\s*(\d{1,2})(?:[:h](\d{2}))?\s*(?:às|as|a|-)\s*(\d{1,2})(?:[:h](\d{2}))?/);
  if (m) {
    const h1 = m[1].padStart(2, '0'), min1 = m[2] || '00';
    const h2 = m[3].padStart(2, '0'), min2 = m[4] || '00';
    return { hora: `${h1}:${min1}`, horaFim: `${h2}:${min2}`, match: m[0] };
  }

  m = textLower.match(palavra('meio-?dia'));
  if (m) return { hora: '12:00', match: m[0] };

  // hora com minutos explícitos: 14:30, 14h30 (com prefixo opcional "às"/"as"/"para")
  m = textLower.match(/(?:(?:às|as|para)\s*)?\b(\d{1,2})[:h](\d{2})\b/);
  if (m) return { hora: `${m[1].padStart(2, '0')}:${m[2]}`, match: m[0] };

  // hora cheia com sufixo h: 14h, 9h (com prefixo opcional)
  m = textLower.match(/(?:(?:às|as|para)\s*)?\b(\d{1,2})h\b/);
  if (m) return { hora: `${m[1].padStart(2, '0')}:00`, match: m[0] };

  // "às 14" / "as 9" sem sufixo h
  m = textLower.match(/(?:às|as)\s+(\d{1,2})\b/);
  if (m) return { hora: `${m[1].padStart(2, '0')}:00`, match: m[0] };

  return null;
}

function buildTitulo(original, dateInfo, timeInfo) {
  let result = original;
  for (const info of [dateInfo, timeInfo]) {
    if (!info) continue;
    result = result.replace(new RegExp(escapeRegex(info.match), 'i'), ' ');
  }
  result = result.replace(/\s{2,}/g, ' ').trim();
  const conectores = /^(dia|às|as|de|do|da|para|no|na)\b|\b(dia|às|as|de|do|da|para|no|na)$/i;
  let anterior;
  do {
    anterior = result;
    result = result.replace(conectores, '').trim();
    result = result.replace(/^[-,.;:\s]+|[-,.;:\s]+$/g, '');
  } while (result !== anterior && result.length);
  if (!result) result = 'Evento';
  return result.charAt(0).toUpperCase() + result.slice(1);
}

export function parseMensagem(textoOriginal) {
  const textLower = textoOriginal.toLowerCase();
  const hoje = spHoje();
  const dateInfo = extractDate(textLower, hoje);
  if (!dateInfo) return { erro: true };
  const timeInfo = extractTime(textLower);
  const titulo = buildTitulo(textoOriginal, dateInfo, timeInfo);
  return {
    erro: false,
    titulo,
    data: dateInfo.data,
    hora: timeInfo ? timeInfo.hora : '',
    obs: timeInfo && timeInfo.horaFim ? `Até ${timeInfo.horaFim}` : '',
  };
}
