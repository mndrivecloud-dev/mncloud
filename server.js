const express = require('express');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { generateRandomBytes, readBigIntFromBuffer } = require('telegram/Helpers');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 8 * 1024 * 1024;      // partes que o navegador envia ao Railway (8 MB)
const TG_PART_SIZE = 512 * 1024;         // tamanho de parte do Telegram (máximo para arquivos grandes)
const TG_WORKERS = 4;                    // partes enviadas em paralelo ao Telegram
const MAX_PARTS_FREE = 4000;             // ~2 GB (conta normal)
const MAX_PARTS_PREMIUM = 8000;          // ~4 GB (Telegram Premium)

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Identificação do dispositivo mostrada em "Dispositivos" no Telegram.
// Usa o user-agent real do navegador do usuário (enviado pelo frontend).
function deviceFor(userAgent) {
    const ua = String(userAgent || DEFAULT_UA).slice(0, 250);

    // O Telegram escolhe o ícone (Windows azul, globo roxo...) a partir destes textos.
    // Aqui o sistema é informado de forma simples ("Windows 10") para ser reconhecido.
    let systemVersion = ua.replace(/^Mozilla\//, '');
    if (/Windows NT 10\.0/.test(ua)) systemVersion = 'Windows 10';
    else if (/Windows NT 6\.3/.test(ua)) systemVersion = 'Windows 8.1';
    else if (/Windows/.test(ua)) systemVersion = 'Windows';
    else if (/Android/.test(ua)) systemVersion = 'Android';
    else if (/iPhone|iPad|iOS/.test(ua)) systemVersion = 'iOS';
    else if (/Mac OS X|Macintosh/.test(ua)) systemVersion = 'macOS';
    else if (/Linux/.test(ua)) systemVersion = 'Linux';

    return {
        deviceModel: 'Browser',
        systemVersion,
        appVersion: '1.0',
        langCode: 'pt-br',
        systemLangCode: 'pt-br',
    };
}


const pendingLogins = {};
const activeSessions = {};
const uploads = {};                      // uploadId -> estado do upload

app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online e operando!' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getClient({ phone, apiId, apiHash, sessionString, userAgent }) {
    let client = activeSessions[phone];
    if (client) {
        if (!client.connected) await client.connect();
        return client;
    }
    if (!sessionString || sessionString.trim() === '' || sessionString === 'undefined') {
        const e = new Error('Sessão expirada. Faça login novamente.');
        e.status = 401;
        throw e;
    }
    client = new TelegramClient(new StringSession(sessionString), Number(apiId), apiHash, {
        connectionRetries: 5,
        useWSS: false,
        ...deviceFor(userAgent),
    });
    await client.connect();
    await client.getMe(); // valida a sessão
    activeSessions[phone] = client;
    return client;
}

async function resolveTarget(client, channelId) {
    let target = channelId;
    if (target && String(target).startsWith('-100')) {
        try {
            target = await client.getEntity(Number(target));
        } catch (e) {
            console.warn('Não foi possível resolver a entidade, usando ID direto.');
        }
    }
    return target || 'me';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Envia o arquivo do disco para o Telegram em streaming (nunca carrega o arquivo inteiro na RAM)
async function uploadFileToTelegram(client, filePath, fileName, size, onProgress) {
    const me = await client.getMe();
    const totalParts = Math.ceil(size / TG_PART_SIZE);
    const maxParts = me.premium ? MAX_PARTS_PREMIUM : MAX_PARTS_FREE;
    if (totalParts > maxParts) {
        throw new Error(
            me.premium
                ? 'Arquivo maior que 4 GB: limite do Telegram.'
                : 'Arquivo maior que ~2 GB: limite do Telegram para contas sem Premium.'
        );
    }

    const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true);
    const fh = await fs.promises.open(filePath, 'r');
    let nextPart = 0;
    let done = 0;

    async function worker() {
        const buf = Buffer.alloc(TG_PART_SIZE);
        while (true) {
            const part = nextPart++;
            if (part >= totalParts) return;
            const offset = part * TG_PART_SIZE;
            const length = Math.min(TG_PART_SIZE, size - offset);
            const { bytesRead } = await fh.read(buf, 0, length, offset);
            const bytes = Buffer.from(buf.subarray(0, bytesRead));

            let attempt = 0;
            while (true) {
                try {
                    await client.invoke(
                        new Api.upload.SaveBigFilePart({
                            fileId,
                            filePart: part,
                            fileTotalParts: totalParts,
                            bytes,
                        })
                    );
                    break;
                } catch (err) {
                    attempt++;
                    if (attempt >= 4) throw err;
                    await sleep(1000 * attempt);
                }
            }
            done++;
            onProgress(done / totalParts);
        }
    }

    try {
        await Promise.all(Array.from({ length: TG_WORKERS }, worker));
    } finally {
        await fh.close();
    }

    return new Api.InputFileBig({ id: fileId, parts: totalParts, name: fileName });
}

function removeTemp(u) {
    if (u && u.path && fs.existsSync(u.path)) {
        try { fs.unlinkSync(u.path); } catch (e) {}
    }
}

// Limpa uploads abandonados (> 6 horas)
setInterval(() => {
    const limit = Date.now() - 6 * 60 * 60 * 1000;
    for (const id of Object.keys(uploads)) {
        if (uploads[id].createdAt < limit) {
            removeTemp(uploads[id]);
            delete uploads[id];
        }
    }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// 1. Enviar código de verificação
// ---------------------------------------------------------------------------
app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone, userAgent } = req.body;
        if (!apiId || !apiHash || !phone) {
            return res.status(400).json({ success: false, message: 'Parâmetros incompletos.' });
        }

        const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
            connectionRetries: 5,
            ...deviceFor(userAgent),
        });
        await client.connect();

        const sendCodeResult = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phone,
                apiId: Number(apiId),
                apiHash: apiHash,
                settings: new Api.CodeSettings({}),
            })
        );

        pendingLogins[phone] = { client, phoneCodeHash: sendCodeResult.phoneCodeHash };
        res.json({ success: true, phoneCodeHash: sendCodeResult.phoneCodeHash });
    } catch (err) {
        console.error('Erro ao enviar código:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// 2. Confirmar código de login
// ---------------------------------------------------------------------------
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        const pending = pendingLogins[phone];
        if (!pending) {
            return res.status(400).json({ success: false, message: 'Sessão expirada ou telefone não encontrado.' });
        }

        const client = pending.client;
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: phoneCodeHash || pending.phoneCodeHash,
                phoneCode: code,
            })
        );

        const sessionString = client.session.save();
        activeSessions[phone] = client;
        const me = await client.getMe();

        let targetChannel = null;
        const dialogs = await client.getDialogs({});
        for (const dialog of dialogs) {
            if (dialog.isChannel && dialog.title === 'MNDRIVE CLOUD') {
                targetChannel = dialog.entity;
                break;
            }
        }

        if (!targetChannel) {
            try {
                const result = await client.invoke(
                    new Api.channels.CreateChannel({
                        title: 'MNDRIVE CLOUD',
                        about: 'Repositório oficial gerido pelo MNDRIVE Quantum Cloud.',
                        megagroup: false,
                    })
                );
                targetChannel = result.chats[0];
            } catch (createErr) {
                console.error('Erro ao criar o canal automaticamente:', createErr);
            }
        }

        const chatId = targetChannel
            ? (targetChannel.id.toString().startsWith('-100') ? targetChannel.id.toString() : `-100${targetChannel.id}`)
            : me.id;

        delete pendingLogins[phone];

        res.json({
            success: true,
            sessionString,
            chatId,
            channelName: 'MNDRIVE CLOUD',
            user: { id: me.id, username: me.username, phone: me.phone },
        });
    } catch (err) {
        console.error('Erro ao autenticar código:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ---------------------------------------------------------------------------
// 3. Upload em partes
//    init  -> cria o arquivo temporário e devolve uploadId + chunkSize
//    chunk -> grava cada parte na posição certa do arquivo (pode repetir sem problema)
//    finish-> inicia o envio ao Telegram em segundo plano
//    status-> o navegador consulta o andamento
// ---------------------------------------------------------------------------
app.post('/api/upload/init', (req, res) => {
    try {
        const { phone, channelId, apiId, apiHash, sessionString, fileName, fileSize, userAgent } = req.body;
        if (!phone || !fileName || !fileSize) {
            return res.status(400).json({ success: false, message: 'Parâmetros incompletos.' });
        }

        const uploadId = crypto.randomBytes(12).toString('hex');
        const tmpPath = path.join(os.tmpdir(), `mndrive-${uploadId}.part`);
        fs.closeSync(fs.openSync(tmpPath, 'w'));

        uploads[uploadId] = {
            createdAt: Date.now(),
            path: tmpPath,
            phone, channelId, apiId, apiHash, sessionString, userAgent,
            fileName: String(fileName),
            fileSize: Number(fileSize),
            totalChunks: Math.ceil(Number(fileSize) / CHUNK_SIZE),
            received: new Set(),
            state: 'receiving',
            progress: 0,
        };

        res.json({ success: true, uploadId, chunkSize: CHUNK_SIZE });
    } catch (err) {
        console.error('Erro no init:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post(
    '/api/upload/chunk',
    express.raw({ type: 'application/octet-stream', limit: '32mb' }),
    async (req, res) => {
        try {
            const u = uploads[req.query.uploadId];
            if (!u) return res.status(404).json({ success: false, message: 'Upload não encontrado (o servidor pode ter reiniciado).' });

            const index = Number(req.query.index);
            if (!Number.isInteger(index) || index < 0 || index >= u.totalChunks) {
                return res.status(400).json({ success: false, message: 'Índice de parte inválido.' });
            }
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                return res.status(400).json({ success: false, message: 'Parte vazia.' });
            }

            const fh = await fs.promises.open(u.path, 'r+');
            try {
                await fh.write(req.body, 0, req.body.length, index * CHUNK_SIZE);
            } finally {
                await fh.close();
            }
            u.received.add(index);
            res.json({ success: true, received: u.received.size, total: u.totalChunks });
        } catch (err) {
            console.error('Erro ao gravar parte:', err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
);

app.post('/api/upload/finish', (req, res) => {
    const u = uploads[req.body.uploadId];
    if (!u) return res.status(404).json({ success: false, message: 'Upload não encontrado.' });

    if (u.received.size !== u.totalChunks) {
        return res.status(400).json({
            success: false,
            message: `Faltam partes (${u.received.size}/${u.totalChunks}).`,
        });
    }
    if (u.state !== 'receiving') {
        return res.json({ success: true, state: u.state });
    }

    u.state = 'sending';
    res.status(202).json({ success: true, state: 'sending' });

    // Segundo plano: o navegador acompanha por /status
    (async () => {
        try {
            const client = await getClient(u);
            const inputFile = await uploadFileToTelegram(
                client, u.path, u.fileName, u.fileSize, (p) => { u.progress = p; }
            );
            const target = await resolveTarget(client, u.channelId);

            const message = await client.sendFile(target, {
                file: inputFile,
                forceDocument: true,
                caption: `📦 MNDRIVE UPLOAD: ${u.fileName}`,
                attributes: [new Api.DocumentAttributeFilename({ fileName: u.fileName })],
            });

            u.messageId = message.id;
            u.fileId = message.media && message.media.document
                ? message.media.document.id.toString()
                : 'tg_file_' + Date.now();
            u.state = 'done';
            console.log(`Upload concluído: ${u.fileName}`);
        } catch (err) {
            console.error('ERRO NO ENVIO AO TELEGRAM:', err);
            if (err.errorMessage === 'AUTH_KEY_UNREGISTERED') delete activeSessions[u.phone];
            u.state = 'error';
            u.error = err.message || 'Erro ao enviar ao Telegram';
        } finally {
            removeTemp(u);
        }
    })();
});

app.get('/api/upload/status/:uploadId', (req, res) => {
    const u = uploads[req.params.uploadId];
    if (!u) return res.status(404).json({ success: false, message: 'Upload não encontrado.' });

    res.json({
        success: true,
        state: u.state,
        progress: u.progress,
        messageId: u.messageId,
        fileId: u.fileId,
        error: u.error,
    });

    if (u.state === 'done' || u.state === 'error') {
        setTimeout(() => { delete uploads[req.params.uploadId]; }, 60 * 1000);
    }
});

// ---------------------------------------------------------------------------
// 4. Apagar arquivo do Telegram
// ---------------------------------------------------------------------------
app.post('/api/delete-file', async (req, res) => {
    try {
        const { phone, channelId, apiId, apiHash, sessionString, messageId, userAgent } = req.body;
        if (!messageId || !phone) {
            return res.status(400).json({ success: false, message: 'Parâmetros insuficientes para exclusão.' });
        }

        const client = await getClient({ phone, apiId, apiHash, sessionString, userAgent });
        const target = await resolveTarget(client, channelId);

        await client.deleteMessages(target, [Number(messageId)], { revoke: true });
        res.json({ success: true, message: 'Arquivo apagado do Telegram com sucesso.' });
    } catch (err) {
        console.error('ERRO AO APAGAR:', err);
        res.status(err.status || 500).json({ success: false, message: err.message || 'Erro interno ao apagar' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
