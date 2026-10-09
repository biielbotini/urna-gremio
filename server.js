'use strict';
/*
 * Urna Eletrônica Escolar - servidor
 * Sem dependências externas: precisa apenas do Node.js (versão 16 ou superior).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.URNA_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */
function erro(status, mensagem) {
  const e = new Error(mensagem);
  e.status = status;
  return e;
}
const agora = () => new Date().toISOString();
const novoId = () => crypto.randomBytes(6).toString('hex');
const limpar = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return { salt, hash };
}
function senhaConfere(senha, reg) {
  const h = crypto.scryptSync(String(senha == null ? '' : senha), reg.salt, 64);
  const b = Buffer.from(reg.hash, 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}

/* ------------------------------------------------------------------ */
/* Banco de dados (arquivo JSON)                                       */
/*                                                                     */
/* Para preservar o sigilo do voto, NÃO se guarda "quem votou em quem". */
/* Guarda-se apenas:                                                   */
/*   presencas: quais números de chamada já votaram em cada sala       */
/*   votos:     contagem de votos por sala (sem ligação com o aluno)   */
/* ------------------------------------------------------------------ */
function novoDb() {
  return {
    config: {
      titulo: 'Eleição do Grêmio Estudantil',
      cargo: 'Presidente',
      digitos: 2,
      pinMesario: '',
      senhaAdmin: hashSenha('admin123'),
      senhaPadrao: true
    },
    candidatos: [], // {id, nome, numero, partido, foto}
    salas: [], // {id, nome, alunos, status: pendente|aberta|encerrada, inicio, fim}
    presencas: {}, // salaId -> [numeros de chamada]
    votos: {} // salaId -> { [candidatoId]: n, branco: n, nulo: n }
  };
}

let db;
let ultimoBackup = 0;

function carregar() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const copia = DB_FILE + '.corrompido-' + Date.now();
      fs.copyFileSync(DB_FILE, copia);
      console.error('Arquivo de dados corrompido. Uma cópia foi guardada em ' + copia);
      db = novoDb();
    }
  } else {
    db = novoDb();
  }
  const base = novoDb();
  db.config = Object.assign({}, base.config, db.config);
  for (const k of ['candidatos', 'salas', 'presencas', 'votos']) if (!db[k]) db[k] = base[k];
  salvar();
}

function backup(forcar) {
  const t = Date.now();
  if (!forcar && t - ultimoBackup < 10 * 60 * 1000) return;
  ultimoBackup = t;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const nome = 'db-' + new Date(t).toISOString().replace(/[:.]/g, '-') + '.json';
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, nome));
    const arqs = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('db-')).sort();
    while (arqs.length > 50) fs.unlinkSync(path.join(BACKUP_DIR, arqs.shift()));
  } catch (e) {
    console.error('Falha ao criar backup:', e.message);
  }
}

function salvar() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  backup(false);
}

const totalPresencas = () => Object.values(db.presencas).reduce((a, l) => a + l.length, 0);
const temVotos = () => totalPresencas() > 0;

/* ------------------------------------------------------------------ */
/* Sessões e proteção contra tentativas de senha                       */
/* ------------------------------------------------------------------ */
const adminTokens = new Map(); // token -> expiração
const sessoesUrna = new Map(); // token -> { salaId }
const falhas = new Map();

function verificarBloqueio(chave) {
  const f = falhas.get(chave);
  if (f && f.ate > Date.now()) throw erro(429, 'Muitas tentativas incorretas. Aguarde 1 minuto.');
}
function registrarFalha(chave) {
  const f = falhas.get(chave) || { n: 0, ate: 0 };
  f.n++;
  if (f.n >= 5) {
    f.ate = Date.now() + 60 * 1000;
    f.n = 0;
  }
  falhas.set(chave, f);
}

function exigirAdmin(req) {
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = adminTokens.get(t);
  if (!t || !exp || exp < Date.now()) {
    adminTokens.delete(t);
    throw erro(401, 'Sessão expirada. Entre novamente.');
  }
  adminTokens.set(t, Date.now() + 8 * 3600 * 1000);
}

function salaDaSessao(token) {
  const s = sessoesUrna.get(String(token || ''));
  const sala = s && db.salas.find((x) => x.id === s.salaId);
  if (!sala) {
    sessoesUrna.delete(String(token || ''));
    throw erro(401, 'Sessão da urna expirada. Selecione a sala novamente.');
  }
  if (sala.status === 'encerrada') throw erro(409, 'A votação desta sala já foi encerrada.');
  return sala;
}

function encerrarSessoesDaSala(salaId) {
  for (const [t, s] of sessoesUrna) if (s.salaId === salaId) sessoesUrna.delete(t);
}

/* ------------------------------------------------------------------ */
/* Regras de negócio                                                   */
/* ------------------------------------------------------------------ */
function parseChamada(valor, sala) {
  const n = parseInt(valor, 10);
  if (!Number.isInteger(n) || n < 1) throw erro(400, 'Número de chamada inválido.');
  if (n > sala.alunos) throw erro(400, 'Esse número de chamada não existe nesta sala.');
  return n;
}

function validarCandidato(c, idAtual) {
  const nome = limpar(c.nome, 80);
  if (!nome) throw erro(400, 'Informe o nome do candidato.');
  const numero = limpar(c.numero, 6);
  if (!/^\d+$/.test(numero) || numero.length !== db.config.digitos) {
    throw erro(400, 'O número do candidato deve ter exatamente ' + db.config.digitos + ' dígito(s).');
  }
  if (db.candidatos.some((x) => x.numero === numero && x.id !== idAtual)) {
    throw erro(409, 'Já existe um candidato com esse número.');
  }
  const partido = limpar(c.partido, 60);
  let foto;
  if ('foto' in c) {
    foto = String(c.foto || '');
    if (foto) {
      if (foto.length > 500000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(foto)) {
        throw erro(400, 'Foto inválida ou muito grande.');
      }
    }
  }
  return { nome, numero, partido, foto };
}

function enderecosRede() {
  const lista = [];
  const ifs = os.networkInterfaces();
  for (const nome of Object.keys(ifs)) {
    for (const i of ifs[nome] || []) {
      if (i.family === 'IPv4' && !i.internal) lista.push('http://' + i.address + ':' + PORT);
    }
  }
  return lista;
}

function estadoAdmin() {
  return {
    config: {
      titulo: db.config.titulo,
      cargo: db.config.cargo,
      digitos: db.config.digitos,
      pinMesario: db.config.pinMesario,
      senhaPadrao: !!db.config.senhaPadrao
    },
    candidatos: db.candidatos.slice().sort((a, b) => collator.compare(a.numero, b.numero)),
    salas: db.salas.map((s) => Object.assign({}, s, { votaram: (db.presencas[s.id] || []).length })),
    temVotos: temVotos(),
    enderecos: enderecosRede()
  };
}

function calcularResultados(filtro) {
  let salas;
  let filtroNome = 'Todas as salas';
  if (!filtro || filtro === 'all') {
    salas = db.salas;
  } else {
    const s = db.salas.find((x) => x.id === filtro);
    if (!s) throw erro(404, 'Sala não encontrada.');
    salas = [s];
    filtroNome = s.nome;
  }
  const contagem = {};
  db.candidatos.forEach((c) => (contagem[c.id] = 0));
  let branco = 0;
  let nulo = 0;
  const porSala = salas.map((s) => {
    const v = db.votos[s.id] || {};
    const vs = { branco: v.branco || 0, nulo: v.nulo || 0 };
    db.candidatos.forEach((c) => {
      vs[c.id] = v[c.id] || 0;
      contagem[c.id] += vs[c.id];
    });
    branco += vs.branco;
    nulo += vs.nulo;
    return {
      id: s.id,
      nome: s.nome,
      alunos: s.alunos,
      status: s.status,
      votaram: (db.presencas[s.id] || []).length,
      votos: vs
    };
  });
  const validos = db.candidatos.reduce((a, c) => a + contagem[c.id], 0);
  const total = validos + branco + nulo;
  const candidatos = db.candidatos
    .map((c) => ({
      id: c.id,
      numero: c.numero,
      nome: c.nome,
      partido: c.partido,
      foto: c.foto || '',
      votos: contagem[c.id]
    }))
    .sort((a, b) => b.votos - a.votos || collator.compare(a.numero, b.numero));
  return {
    titulo: db.config.titulo,
    cargo: db.config.cargo,
    filtro: filtro || 'all',
    filtroNome,
    geradoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    candidatos,
    branco,
    nulo,
    validos,
    total,
    votaram: porSala.reduce((a, s) => a + s.votaram, 0),
    salasEncerradas: porSala.filter((s) => s.status === 'encerrada').length,
    salasTotal: porSala.length,
    porSala
  };
}

function gerarCsv(r) {
  const q = (v) => {
    v = String(v);
    return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const pct = (n) => (r.total ? ((n * 100) / r.total).toFixed(1).replace('.', ',') : '0,0');
  const linhas = [];
  linhas.push([r.titulo + ' - ' + r.cargo]);
  linhas.push(['Sala', r.filtroNome]);
  linhas.push(['Gerado em', r.geradoEm]);
  linhas.push([]);
  linhas.push(['Posição', 'Número', 'Candidato', 'Chapa/Turma', 'Votos', '% do total']);
  r.candidatos.forEach((c, i) => linhas.push([i + 1, c.numero, c.nome, c.partido, c.votos, pct(c.votos)]));
  linhas.push(['', '', 'Votos em branco', '', r.branco, pct(r.branco)]);
  linhas.push(['', '', 'Votos nulos', '', r.nulo, pct(r.nulo)]);
  linhas.push(['', '', 'TOTAL DE VOTOS', '', r.total, '100,0']);
  linhas.push([]);
  const cab = ['Sala', 'Situação', 'Votaram', 'Alunos'];
  r.candidatos.forEach((c) => cab.push(c.nome + ' (' + c.numero + ')'));
  cab.push('Branco', 'Nulo');
  linhas.push(cab);
  r.porSala.forEach((s) => {
    const l = [s.nome, s.status, s.votaram, s.alunos];
    r.candidatos.forEach((c) => l.push(s.votos[c.id] || 0));
    l.push(s.votos.branco, s.votos.nulo);
    linhas.push(l);
  });
  return '﻿' + linhas.map((l) => l.map(q).join(';')).join('\r\n');
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
function enviarJson(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(corpo);
}

function lerCorpo(req, limite = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0;
    let estourou = false;
    const partes = [];
    req.on('data', (c) => {
      tam += c.length;
      if (tam > limite) estourou = true;
      else partes.push(c);
    });
    req.on('end', () => {
      if (estourou) return reject(erro(413, 'Requisição muito grande.'));
      if (!partes.length) return resolve({});
      try {
        const obj = JSON.parse(Buffer.concat(partes).toString('utf8'));
        resolve(obj && typeof obj === 'object' ? obj : {});
      } catch (e) {
        reject(erro(400, 'Dados inválidos.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function servirEstatico(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw erro(405, 'Método não permitido.');
  const mapa = { '/': '/urna.html', '/urna': '/urna.html', '/admin': '/admin.html' };
  let rel;
  try {
    rel = mapa[pathname] || decodeURIComponent(pathname);
  } catch (e) {
    throw erro(400, 'Endereço inválido.');
  }
  const arquivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (arquivo !== PUBLIC_DIR && !arquivo.startsWith(PUBLIC_DIR + path.sep)) throw erro(403, 'Acesso negado.');
  fs.readFile(arquivo, (err, dados) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Página não encontrada.');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : dados);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const ip = req.socket.remoteAddress || 'x';
  const ok = (obj) => enviarJson(res, 200, obj || { ok: true });
  const corpo = m === 'GET' || m === 'DELETE' ? {} : await lerCorpo(req);

  /* ------------------------- Urna (mesário/eleitor) ------------------------- */
  if (m === 'GET' && p === '/api/urna/info') {
    const token = url.searchParams.get('token');
    let sessao = null;
    const s = token && sessoesUrna.get(token);
    const salaSessao = s && db.salas.find((x) => x.id === s.salaId);
    if (salaSessao && salaSessao.status !== 'encerrada') {
      sessao = { id: salaSessao.id, nome: salaSessao.nome, alunos: salaSessao.alunos };
    }
    return ok({
      titulo: db.config.titulo,
      cargo: db.config.cargo,
      digitos: db.config.digitos,
      pinObrigatorio: !!db.config.pinMesario,
      salas: db.salas
        .slice()
        .sort((a, b) => collator.compare(a.nome, b.nome))
        .map((x) => ({ id: x.id, nome: x.nome, alunos: x.alunos, status: x.status })),
      candidatos: db.candidatos.map((c) => ({
        numero: c.numero,
        nome: c.nome,
        partido: c.partido,
        foto: c.foto || ''
      })),
      sessao
    });
  }

  if (m === 'POST' && p === '/api/urna/abrir') {
    verificarBloqueio('pin:' + ip);
    const sala = db.salas.find((x) => x.id === corpo.salaId);
    if (!sala) throw erro(404, 'Sala não encontrada.');
    if (sala.status === 'encerrada') throw erro(409, 'A votação desta sala já foi encerrada.');
    if (!db.candidatos.length) throw erro(409, 'Nenhum candidato cadastrado.');
    if (db.config.pinMesario && limpar(corpo.pin, 20) !== db.config.pinMesario) {
      registrarFalha('pin:' + ip);
      throw erro(401, 'Senha do mesário incorreta.');
    }
    if (sala.status !== 'aberta') {
      sala.status = 'aberta';
      if (!sala.inicio) sala.inicio = agora();
      salvar();
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessoesUrna.set(token, { salaId: sala.id });
    return ok({ token, sala: { id: sala.id, nome: sala.nome, alunos: sala.alunos } });
  }

  if (m === 'POST' && p === '/api/urna/chamada') {
    const sala = salaDaSessao(corpo.token);
    const n = parseChamada(corpo.chamada, sala);
    if ((db.presencas[sala.id] || []).includes(n)) throw erro(409, 'Este aluno já votou.');
    return ok();
  }

  if (m === 'POST' && p === '/api/urna/votar') {
    const sala = salaDaSessao(corpo.token);
    const n = parseChamada(corpo.chamada, sala);
    const lista = db.presencas[sala.id] || (db.presencas[sala.id] = []);
    if (lista.includes(n)) throw erro(409, 'Este aluno já votou.');
    const voto = String(corpo.voto == null ? '' : corpo.voto);
    let chave;
    if (voto === 'branco') chave = 'branco';
    else if (voto === 'nulo') chave = 'nulo';
    else if (/^\d+$/.test(voto)) {
      const c = db.candidatos.find((x) => x.numero === voto);
      chave = c ? c.id : 'nulo';
    } else throw erro(400, 'Voto inválido.');
    const v = db.votos[sala.id] || (db.votos[sala.id] = {});
    v[chave] = (v[chave] || 0) + 1;
    lista.push(n);
    salvar();
    return ok();
  }

  if (m === 'POST' && p === '/api/urna/encerrar') {
    const sala = salaDaSessao(corpo.token);
    sala.status = 'encerrada';
    sala.fim = agora();
    encerrarSessoesDaSala(sala.id);
    salvar();
    return ok({ nome: sala.nome, votaram: (db.presencas[sala.id] || []).length });
  }

  /* ------------------------------ Administração ------------------------------ */
  if (m === 'POST' && p === '/api/admin/login') {
    verificarBloqueio('admin:' + ip);
    if (!senhaConfere(corpo.senha, db.config.senhaAdmin)) {
      registrarFalha('admin:' + ip);
      throw erro(401, 'Senha incorreta.');
    }
    const token = crypto.randomBytes(24).toString('hex');
    adminTokens.set(token, Date.now() + 8 * 3600 * 1000);
    return ok({ token });
  }

  if (!p.startsWith('/api/admin/')) throw erro(404, 'Rota não encontrada.');
  exigirAdmin(req);

  if (m === 'GET' && p === '/api/admin/dados') return ok(estadoAdmin());

  if (m === 'PUT' && p === '/api/admin/config') {
    const titulo = limpar(corpo.titulo, 80);
    const cargo = limpar(corpo.cargo, 60);
    if (!titulo || !cargo) throw erro(400, 'Informe o título da eleição e o cargo.');
    const dig = parseInt(corpo.digitos, 10);
    if (!(dig >= 1 && dig <= 4)) throw erro(400, 'A quantidade de dígitos deve ser de 1 a 4.');
    if (dig !== db.config.digitos && db.candidatos.length) {
      throw erro(409, 'Remova os candidatos antes de mudar a quantidade de dígitos.');
    }
    db.config.titulo = titulo;
    db.config.cargo = cargo;
    db.config.digitos = dig;
    db.config.pinMesario = limpar(corpo.pinMesario, 20);
    salvar();
    return ok();
  }

  if (m === 'POST' && p === '/api/admin/senha') {
    if (!senhaConfere(corpo.atual, db.config.senhaAdmin)) throw erro(401, 'A senha atual está incorreta.');
    const nova = String(corpo.nova || '');
    if (nova.length < 6) throw erro(400, 'A nova senha deve ter pelo menos 6 caracteres.');
    db.config.senhaAdmin = hashSenha(nova);
    db.config.senhaPadrao = false;
    salvar();
    return ok();
  }

  /* Candidatos */
  if (m === 'POST' && p === '/api/admin/candidatos') {
    if (temVotos()) throw erro(409, 'Já existem votos registrados. Zere a votação para alterar a lista de candidatos.');
    const c = validarCandidato(corpo, null);
    db.candidatos.push({ id: novoId(), nome: c.nome, numero: c.numero, partido: c.partido, foto: c.foto || '' });
    salvar();
    return ok();
  }

  let mt = p.match(/^\/api\/admin\/candidatos\/([a-f0-9]+)$/);
  if (mt) {
    const cand = db.candidatos.find((x) => x.id === mt[1]);
    if (!cand) throw erro(404, 'Candidato não encontrado.');
    if (m === 'PUT') {
      const c = validarCandidato(corpo, cand.id);
      if (temVotos() && c.numero !== cand.numero) {
        throw erro(409, 'Já existem votos registrados: não é possível alterar o número do candidato.');
      }
      cand.nome = c.nome;
      cand.numero = c.numero;
      cand.partido = c.partido;
      if (c.foto !== undefined) cand.foto = c.foto;
      salvar();
      return ok();
    }
    if (m === 'DELETE') {
      if (temVotos()) throw erro(409, 'Já existem votos registrados. Zere a votação para remover candidatos.');
      db.candidatos = db.candidatos.filter((x) => x.id !== cand.id);
      salvar();
      return ok();
    }
  }

  /* Salas */
  if (m === 'POST' && p === '/api/admin/salas') {
    const alunos = corpo.alunos == null || corpo.alunos === '' ? 50 : parseInt(corpo.alunos, 10);
    if (!(alunos >= 1 && alunos <= 99)) throw erro(400, 'A quantidade de alunos deve ser de 1 a 99.');
    const nomes = (Array.isArray(corpo.nomes) ? corpo.nomes : [corpo.nome]).map((n) => limpar(n, 40)).filter(Boolean);
    if (!nomes.length) throw erro(400, 'Informe o nome da sala.');
    const existentes = new Set(db.salas.map((s) => s.nome.toLowerCase()));
    const novos = [];
    for (const nome of nomes) {
      if (existentes.has(nome.toLowerCase())) throw erro(409, 'A sala "' + nome + '" já está cadastrada.');
      existentes.add(nome.toLowerCase());
      novos.push({ id: novoId(), nome, alunos, status: 'pendente' });
    }
    db.salas.push(...novos);
    db.salas.sort((a, b) => collator.compare(a.nome, b.nome));
    salvar();
    return ok({ criadas: novos.length });
  }

  mt = p.match(/^\/api\/admin\/salas\/([a-f0-9]+)(?:\/(reabrir|encerrar))?$/);
  if (mt) {
    const sala = db.salas.find((x) => x.id === mt[1]);
    if (!sala) throw erro(404, 'Sala não encontrada.');
    const acao = mt[2];
    if (m === 'POST' && acao === 'reabrir') {
      sala.status = 'pendente';
      delete sala.fim;
      salvar();
      return ok();
    }
    if (m === 'POST' && acao === 'encerrar') {
      sala.status = 'encerrada';
      sala.fim = agora();
      encerrarSessoesDaSala(sala.id);
      salvar();
      return ok();
    }
    if (m === 'PUT' && !acao) {
      const nome = limpar(corpo.nome, 40);
      const alunos = parseInt(corpo.alunos, 10);
      if (!nome) throw erro(400, 'Informe o nome da sala.');
      if (!(alunos >= 1 && alunos <= 99)) throw erro(400, 'A quantidade de alunos deve ser de 1 a 99.');
      if (db.salas.some((x) => x.id !== sala.id && x.nome.toLowerCase() === nome.toLowerCase())) {
        throw erro(409, 'Já existe uma sala com esse nome.');
      }
      const maior = Math.max(0, ...(db.presencas[sala.id] || []));
      if (alunos < maior) throw erro(409, 'Já votou o aluno de chamada ' + maior + '; a quantidade de alunos não pode ser menor que isso.');
      sala.nome = nome;
      sala.alunos = alunos;
      db.salas.sort((a, b) => collator.compare(a.nome, b.nome));
      salvar();
      return ok();
    }
    if (m === 'DELETE' && !acao) {
      if ((db.presencas[sala.id] || []).length) {
        throw erro(409, 'Esta sala já tem votos registrados. Zere a votação para excluí-la.');
      }
      db.salas = db.salas.filter((x) => x.id !== sala.id);
      encerrarSessoesDaSala(sala.id);
      salvar();
      return ok();
    }
  }

  /* Resultados */
  if (m === 'GET' && p === '/api/admin/resultados') {
    return ok(calcularResultados(url.searchParams.get('sala') || 'all'));
  }

  if (m === 'GET' && p === '/api/admin/csv') {
    const csv = gerarCsv(calcularResultados(url.searchParams.get('sala') || 'all'));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(csv);
  }

  if (m === 'POST' && p === '/api/admin/zerar') {
    if (corpo.confirmacao !== 'ZERAR') throw erro(400, 'Confirmação inválida.');
    backup(true);
    db.presencas = {};
    db.votos = {};
    db.salas.forEach((s) => {
      s.status = 'pendente';
      delete s.inicio;
      delete s.fim;
    });
    sessoesUrna.clear();
    salvar();
    return ok();
  }

  throw erro(404, 'Rota não encontrada.');
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */
carregar();

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else servirEstatico(req, res, url.pathname);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) enviarJson(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno do servidor.' });
    else res.end();
  }
});

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('A porta ' + PORT + ' já está em uso. Feche o outro programa ou inicie com outra porta (ex.: PORT=3001).');
  } else {
    console.error(e);
  }
  process.exit(1);
});

servidor.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  URNA ELETRÔNICA ESCOLAR - servidor iniciado');
  console.log('==============================================');
  console.log('  Urna (votação):  http://localhost:' + PORT + '/urna');
  console.log('  Administração:   http://localhost:' + PORT + '/admin');
  const rede = enderecosRede();
  if (rede.length) {
    console.log('\n  Em outros computadores da rede da escola:');
    rede.forEach((e) => console.log('    Urna: ' + e + '/urna   |   Admin: ' + e + '/admin'));
  }
  console.log('\n  Senha inicial da administração: admin123 (troque em Configurações)');
  console.log('  Os dados ficam em: ' + DB_FILE);
  console.log('  Para encerrar o servidor, feche esta janela ou pressione Ctrl+C.\n');
});
