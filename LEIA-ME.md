# Urna Eletrônica Escolar

Sistema de votação para eleições da escola (grêmio, representante de turma etc.), com:

- **Urna** parecida com a urna eletrônica do TSE: o eleitor digita o número do candidato no teclado, vê nome, chapa e foto, e usa BRANCO / CORRIGE / CONFIRMA.
- **Mesário** escolhe a sala antes de começar; o **aluno** informa o número da chamada (1 a 50) antes de votar.
- **Painel de administração**: cadastro de candidatos (com foto) e salas, resultados com **gráficos**, **impressão** e planilha **CSV**.

## 1. Instalação (uma vez só)

1. Instale o **Node.js** (versão LTS) em <https://nodejs.org> — é só avançar até o fim.
2. Copie esta pasta (`urna-escolar`) para o computador que será o **servidor** (pode ser o mesmo da urna).
3. Não precisa instalar mais nada (nenhum `npm install`).

## 2. Como iniciar

- **Windows:** dê dois cliques em **`iniciar.bat`**. Uma janela preta vai abrir e mostrar os endereços. **Não feche essa janela durante a votação.**
- **Linux / Mac:** `./iniciar.sh` (ou `node server.js`).

Endereços (troque `localhost` pelo IP mostrado na janela para acessar de outros computadores da escola):

| Para quê | Endereço |
|---|---|
| Urna (votação) | `http://localhost:3000/urna` |
| Administração | `http://localhost:3000/admin` |

**Senha inicial da administração: `admin123`** — troque em *Configurações* antes de usar.

> Dica: o servidor pode ficar num computador e as urnas em outros (notebooks, por exemplo), todos na mesma rede/Wi-Fi da escola. Nesse caso, abra `http://IP-DO-SERVIDOR:3000/urna` na urna.

## 3. Preparação (administração)

1. Entre em `/admin` com a senha.
2. **Configurações**: defina o título da eleição, o cargo (ex.: *Presidente do Grêmio*), a quantidade de dígitos do número dos candidatos (padrão 2) e, se quiser, uma **senha do mesário**.
3. **Candidatos**: cadastre nome, número, chapa/turma e foto.
4. **Salas**: cadastre as salas (dá para colar várias de uma vez, uma por linha) e a quantidade de alunos de cada uma (padrão 50 → chamadas de 1 a 50).
5. **Faça um teste** e depois use **Configurações → Zerar votação** para começar do zero.

## 4. No dia da votação

**Mesário** (na urna):
1. Abre `/urna`, escolhe a **sala** e clica em *Iniciar votação* (a urna entra em tela cheia).
2. Cada aluno digita o **número da chamada** e aperta **CONFIRMA**.
3. Para **encerrar a votação da sala**, use o atalho do mesário (veja abaixo).

**Eleitor:**
1. Digita o número do candidato (pelo teclado do computador ou clicando na urna).
2. Aparecem nome, chapa e foto. **CONFIRMA** (Enter) registra o voto; **CORRIGE** (Backspace) reinicia; **BRANCO** (tecla B) vota em branco.
3. Número que não existe = **voto nulo** (a urna avisa "NÚMERO ERRADO").
4. Depois de confirmar, aparece **FIM** e a urna volta sozinha para o próximo aluno.

### Atalho secreto do mesário

> **Ctrl + E** — encerra a votação da sala. **Não aparece em nenhum lugar da tela**; divulgue só aos mesários.

- Funciona na tela em que se digita o número da chamada (entre um aluno e outro). Durante o voto de um aluno, o atalho é ignorado, para não interromper ninguém.
- Pede uma confirmação (Enter confirma, Esc cancela).
- Depois de encerrada, a sala **não pode mais votar**. Se foi engano, a administração pode **reabrir** a sala em *Salas → Reabrir* (quem já votou continua bloqueado).

### Modo quiosque (recomendado)

Para o aluno não conseguir sair da urna nem usar a barra de endereços, abra a urna em tela cheia:

- **Windows:** use **`iniciar-urna-tela-cheia.bat`** (abre o Chrome/Edge em modo quiosque; sair com **Alt + F4**). Se o servidor estiver em outro computador: `iniciar-urna-tela-cheia.bat 192.168.0.10:3000`.
- Ou simplesmente aperte **F11** no navegador.

## 5. Resultados

Aba **Resultados**: escolha *Todas as salas* ou uma sala específica. Mostra totais, ranking, votos em branco/nulos, gráfico de barras, gráfico de pizza e a votação sala por sala.

- **Imprimir**: gera uma folha com cabeçalho, tabelas, gráficos e linhas para assinatura.
- **Baixar planilha (CSV)**: abre no Excel.
- Enquanto houver salas não encerradas, o resultado aparece marcado como **parcial**.

## 6. Segurança e sigilo

- **Sigilo do voto:** o sistema guarda apenas *quem já votou* (número da chamada, para impedir voto repetido) e *a contagem de votos por sala*. **Não existe registro ligando um aluno ao seu voto.**
- Cada número de chamada só vota **uma vez por sala**.
- Depois que o primeiro voto é registrado, não é possível adicionar, remover ou trocar o número de candidatos (só corrigir nome, chapa e foto).
- Troque a senha padrão e, se desejar, defina a senha do mesário.
- A administração só deve ser acessada por quem coordena a eleição; deixe a urna sem acesso a `/admin`.

## 7. Dados e backup

Tudo fica em `data/db.json`. O sistema cria **backups automáticos** em `data/backups/` (a cada 10 minutos de uso e antes de zerar a votação). Para guardar o resultado final, copie a pasta `data`.

Para mudar a porta (padrão 3000): `PORT=3001 node server.js` (Linux/Mac) ou, no Windows, `set PORT=3001` antes de `node server.js`.

## 8. Problemas comuns

| Problema | Solução |
|---|---|
| "Node.js não encontrado" | Instale o Node.js LTS e abra o `iniciar.bat` de novo. |
| Outro computador não abre a urna | Use o IP mostrado na janela do servidor e libere a porta 3000 no firewall do Windows (aceite o aviso na primeira execução). |
| "Porta 3000 em uso" | Feche o outro programa ou use outra porta (item 7). |
| A urna perdeu a conexão | Confira se a janela do servidor continua aberta; a urna tenta reconectar sozinha. |
| Sala encerrada por engano | Administração → Salas → **Reabrir**. |
| Esqueci a senha do admin | Pare o servidor, apague o arquivo `data/db.json` **somente se ainda não houver votos** (ele volta à senha `admin123`). Se já houver votos, faça cópia da pasta `data` antes e peça ajuda técnica. |
