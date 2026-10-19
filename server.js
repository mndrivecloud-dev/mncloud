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
// CONFIGURAÇÃO
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 8 * 1024 * 1024;
const TG_PART_SIZE = 512 * 1024;
const TG_WORKERS = 4;
const MAX_PARTS_FREE = 4000;
const MAX_PARTS_PREMIUM = 8000;

// Divide arquivos maiores que 2 GiB.
const SPLIT_THRESHOLD = 2 * 1024 * 1024 * 1024;

// Cada arquivo enviado ao Telegram terá até aproximadamente 1.855 MiB.
const MAX_UPLOAD_PART_SIZE = 1900 * 1024 * 1024;

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function deviceFor(userAgent) {
    const ua = String(userAgent || DEFAULT_UA);

    let systemVersion = 'Windows 10 x64';

    if (/Windows/i.test(ua)) systemVersion = 'Windows 10 x64';
    else if (/Android/i.test(ua)) systemVersion = 'menozin';
    else if (/iPhone|iPad|iOS/i.test(ua)) systemVersion = 'iOS';
    else if (/Mac OS X|Macintosh/i.test(ua)) systemVersion = 'macOS';
    else if (/Linux|X11/i.test(ua)) systemVersion = 'Linux';

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
const uploads = {};

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'MNDRIVE API no Railway está online e operando!',
    });
});

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

async function getClient({
    phone,
    apiId,
    apiHash,
    sessionString,
    userAgent,
}) {
    let client = activeSessions[phone];

    if (client) {
        if (!client.connected) await client.connect();
        return client;
    }

    if (
        !sessionString ||
        sessionString.trim() === '' ||
        sessionString === 'undefined'
    ) {
        const e = new Error('Sessão expirada. Faça login novamente.');
        e.status = 401;
        throw e;
    }

    client = new TelegramClient(
        new StringSession(sessionString),
        Number(apiId),
        apiHash,
        {
            connectionRetries: 5,
            useWSS: false,
            ...deviceFor(userAgent),
        }
    );

    await client.connect();
    await client.getMe();

    activeSessions[phone] = client;
    return client;
}

async function resolveTarget(client, channelId) {
    let target = channelId;

    if (target && String(target).startsWith('-100')) {
        try {
            target = await client.getEntity(Number(target));
        } catch (e) {
            console.warn(
                'Não foi possível resolver a entidade, usando ID direto.'
            );
        }
    }

    return target || 'me';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// ENVIO DE UM ARQUIVO OU DE UMA PARTE AO TELEGRAM
// Lê diretamente do disco, sem carregar o arquivo inteiro na memória.
// startOffset indica onde começa a parte dentro do arquivo original.
// ---------------------------------------------------------------------------

async function uploadFileToTelegram(
    client,
    filePath,
    fileName,
    size,
    onProgress,
    startOffset = 0
) {
    const me = await client.getMe();
    const totalParts = Math.ceil(size / TG_PART_SIZE);
    const maxParts = me.premium
        ? MAX_PARTS_PREMIUM
        : MAX_PARTS_FREE;

    if (totalParts > maxParts) {
        throw new Error(
            me.premium
                ? 'Parte maior que o limite de 4 GB do Telegram.'
                : 'Parte maior que o limite aproximado de 2 GB do Telegram.'
        );
    }

    const fileId = readBigIntFromBuffer(
        generateRandomBytes(8),
        true,
        true
    );

    const fh = await fs.promises.open(filePath, 'r');

    let nextPart = 0;
    let done = 0;

    async function worker() {
        const buf = Buffer.alloc(TG_PART_SIZE);

        while (true) {
            const part = nextPart++;

            if (part >= totalParts) return;

            const offset = startOffset + part * TG_PART_SIZE;
            const length = Math.min(
                TG_PART_SIZE,
                size - part * TG_PART_SIZE
            );

            const { bytesRead } = await fh.read(
                buf,
                0,
                length,
                offset
            );

            if (bytesRead !== length) {
                throw new Error(
                    `Erro ao ler os dados do arquivo: ${fileName}`
                );
            }

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
        await Promise.all(
            Array.from({ length: TG_WORKERS }, () => worker())
        );
    } finally {
        await fh.close();
    }

    return new Api.InputFileBig({
        id: fileId,
        parts: totalParts,
        name: fileName,
    });
}

function removeTemp(upload) {
    if (upload && upload.path && fs.existsSync(upload.path)) {
        try {
            fs.unlinkSync(upload.path);
        } catch (e) {
            console.error('Não foi possível remover arquivo temporário:', e.message);
        }
    }
}

// Remove uploads abandonados há mais de 6 horas.
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
// 1. ENVIAR CÓDIGO DE VERIFICAÇÃO
// ---------------------------------------------------------------------------

app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone, userAgent } = req.body;

        if (!apiId || !apiHash || !phone) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros incompletos.',
            });
        }

        const client = new TelegramClient(
            new StringSession(''),
            Number(apiId),
            apiHash,
            {
                connectionRetries: 5,
                ...deviceFor(userAgent),
            }
        );

        await client.connect();

        const sendCodeResult = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phone,
                apiId: Number(apiId),
                apiHash,
                settings: new Api.CodeSettings({}),
            })
        );

        pendingLogins[phone] = {
            client,
            phoneCodeHash: sendCodeResult.phoneCodeHash,
        };

        res.json({
            success: true,
            phoneCodeHash: sendCodeResult.phoneCodeHash,
        });
    } catch (err) {
        console.error('Erro ao enviar código:', err);

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

// ---------------------------------------------------------------------------
// 2. CONFIRMAR LOGIN
// ---------------------------------------------------------------------------

app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { phone, code, phoneCodeHash } = req.body;
        const pending = pendingLogins[phone];

        if (!pending) {
            return res.status(400).json({
                success: false,
                message: 'Sessão expirada ou telefone não encontrado.',
            });
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
                console.error(
                    'Erro ao criar o canal automaticamente:',
                    createErr
                );
            }
        }

        const chatId = targetChannel
            ? (
                targetChannel.id.toString().startsWith('-100')
                    ? targetChannel.id.toString()
                    : `-100${targetChannel.id}`
            )
            : me.id;

        delete pendingLogins[phone];

        res.json({
            success: true,
            sessionString,
            chatId,
            channelName: 'MNDRIVE CLOUD',
            user: {
                id: me.id,
                username: me.username,
                phone: me.phone,
            },
        });
    } catch (err) {
        console.error('Erro ao autenticar código:', err);

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

// ---------------------------------------------------------------------------
// 3. INICIAR UPLOAD
// ---------------------------------------------------------------------------

app.post('/api/upload/init', (req, res) => {
    try {
        const {
            phone,
            channelId,
            apiId,
            apiHash,
            sessionString,
            fileName,
            fileSize,
            userAgent,
        } = req.body;

        if (
            !phone ||
            !fileName ||
            !Number.isSafeInteger(Number(fileSize)) ||
            Number(fileSize) <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros de arquivo inválidos ou incompletos.',
            });
        }

        const uploadId = crypto.randomBytes(12).toString('hex');
        const tmpPath = path.join(
            os.tmpdir(),
            `mndrive-${uploadId}.part`
        );

        fs.closeSync(fs.openSync(tmpPath, 'w'));

        uploads[uploadId] = {
            createdAt: Date.now(),
            path: tmpPath,
            phone,
            channelId,
            apiId,
            apiHash,
            sessionString,
            userAgent,
            fileName: String(fileName),
            fileSize: Number(fileSize),
            totalChunks: Math.ceil(Number(fileSize) / CHUNK_SIZE),
            received: new Set(),
            state: 'receiving',
            progress: 0,
        };

        res.json({
            success: true,
            uploadId,
            chunkSize: CHUNK_SIZE,
        });
    } catch (err) {
        console.error('Erro no init:', err);

        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

// ---------------------------------------------------------------------------
// 4. RECEBER BLOCOS ENVIADOS PELO NAVEGADOR
// ---------------------------------------------------------------------------

app.post(
    '/api/upload/chunk',
    express.raw({
        type: 'application/octet-stream',
        limit: '32mb',
    }),
    async (req, res) => {
        try {
            const u = uploads[req.query.uploadId];

            if (!u) {
                return res.status(404).json({
                    success: false,
                    message: 'Upload não encontrado. O servidor pode ter reiniciado.',
                });
            }

            if (u.state !== 'receiving') {
                return res.status(409).json({
                    success: false,
                    message: 'Este upload não está mais recebendo blocos.',
                });
            }

            const index = Number(req.query.index);

            if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= u.totalChunks
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Índice de parte inválido.',
                });
            }

            if (
                !Buffer.isBuffer(req.body) ||
                req.body.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Parte vazia.',
                });
            }

            const expectedLength = Math.min(
                CHUNK_SIZE,
                u.fileSize - index * CHUNK_SIZE
            );

            if (req.body.length !== expectedLength) {
                return res.status(400).json({
                    success: false,
                    message: 'Tamanho do bloco recebido é inválido.',
                });
            }

            const fh = await fs.promises.open(u.path, 'r+');

            try {
                await fh.write(
                    req.body,
                    0,
                    req.body.length,
                    index * CHUNK_SIZE
                );
            } finally {
                await fh.close();
            }

            u.received.add(index);

            res.json({
                success: true,
                received: u.received.size,
                total: u.totalChunks,
            });
        } catch (err) {
            console.error('Erro ao gravar parte:', err);

            res.status(500).json({
                success: false,
                message: err.message,
            });
        }
    }
);

// ---------------------------------------------------------------------------
// 5. FINALIZAR UPLOAD E ENVIAR AO TELEGRAM
// ---------------------------------------------------------------------------

app.post('/api/upload/finish', (req, res) => {
    const u = uploads[req.body.uploadId];

    if (!u) {
        return res.status(404).json({
            success: false,
            message: 'Upload não encontrado.',
        });
    }

    if (u.received.size !== u.totalChunks) {
        return res.status(400).json({
            success: false,
            message: `Faltam partes (${u.received.size}/${u.totalChunks}).`,
        });
    }

    if (u.state !== 'receiving') {
        return res.json({
            success: true,
            state: u.state,
        });
    }

    u.state = 'sending';

    res.status(202).json({
        success: true,
        state: 'sending',
    });

    (async () => {
        try {
            const client = await getClient(u);
            const target = await resolveTarget(client, u.channelId);

            // Arquivo de até 2 GiB: um documento.
            // Arquivo maior que 2 GiB: documentos numerados.
            const partSize = u.fileSize > SPLIT_THRESHOLD
                ? MAX_UPLOAD_PART_SIZE
                : u.fileSize;

            const totalFileParts = Math.ceil(u.fileSize / partSize);

            const ext = path.extname(u.fileName);
            const baseName = path.basename(u.fileName, ext);

            const sentMessages = [];

            for (let i = 0; i < totalFileParts; i++) {
                const startOffset = i * partSize;

                const currentSize = Math.min(
                    partSize,
                    u.fileSize - startOffset
                );

                const partName = totalFileParts > 1
                    ? `${baseName} - Parte ${i + 1}${ext}`
                    : u.fileName;

                console.log(
                    `Enviando ${partName} (${i + 1}/${totalFileParts})`
                );

                const inputFile = await uploadFileToTelegram(
                    client,
                    u.path,
                    partName,
                    currentSize,
                    (p) => {
                        u.progress = (i + p) / totalFileParts;
                    },
                    startOffset
                );

                const message = await client.sendFile(target, {
                    file: inputFile,
                    forceDocument: true,

                    caption: totalFileParts > 1
                        ? `📦 ${u.fileName} — Parte ${i + 1} de ${totalFileParts}`
                        : `📦 MNDRIVE UPLOAD: ${u.fileName}`,

                    attributes: [
                        new Api.DocumentAttributeFilename({
                            fileName: partName,
                        }),
                    ],
                });

                sentMessages.push(message);

                u.progress = (i + 1) / totalFileParts;
                u.messageIds = sentMessages.map((m) => m.id);
            }

            u.messageId = sentMessages[0].id;
            u.messageIds = sentMessages.map((m) => m.id);

            u.fileId =
                sentMessages[0].media &&
                sentMessages[0].media.document
                    ? sentMessages[0].media.document.id.toString()
                    : 'tg_file_' + Date.now();

            u.state = 'done';

            console.log(
                `Upload concluído: ${u.fileName} (${totalFileParts} parte(s))`
            );
        } catch (err) {
            console.error('ERRO NO ENVIO AO TELEGRAM:', err);

            if (err.errorMessage === 'AUTH_KEY_UNREGISTERED') {
                delete activeSessions[u.phone];
            }

            u.state = 'error';
            u.error = err.message || 'Erro ao enviar ao Telegram';
        } finally {
            removeTemp(u);
        }
    })();
});

// ---------------------------------------------------------------------------
// 6. CONSULTAR PROGRESSO
// ---------------------------------------------------------------------------

app.get('/api/upload/status/:uploadId', (req, res) => {
    const u = uploads[req.params.uploadId];

    if (!u) {
        return res.status(404).json({
            success: false,
            message: 'Upload não encontrado.',
        });
    }

    res.json({
        success: true,
        state: u.state,
        progress: u.progress,
        messageId: u.messageId,
        messageIds: u.messageIds,
        fileId: u.fileId,
        error: u.error,
    });

    if (u.state === 'done' || u.state === 'error') {
        setTimeout(() => {
            delete uploads[req.params.uploadId];
        }, 60 * 1000);
    }
});

// ---------------------------------------------------------------------------
// 7. EXCLUIR ARQUIVO OU PARTES DO TELEGRAM
// Aceita messageId ou messageIds.
// ---------------------------------------------------------------------------

app.post('/api/delete-file', async (req, res) => {
    try {
        const {
            phone,
            channelId,
            apiId,
            apiHash,
            sessionString,
            messageId,
            messageIds,
            userAgent
        } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Número de telefone não informado.'
            });
        }

        const idsRecebidos = [
            ...(Array.isArray(messageIds) ? messageIds : []),
            ...(messageId != null ? [messageId] : [])
        ];

        const ids = [...new Set(
            idsRecebidos
                .map(id => Number(id))
                .filter(id => Number.isSafeInteger(id) && id > 0)
        )];

        if (ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Nenhum ID válido de mensagem foi informado.'
            });
        }

        const client = await getClient({
            phone,
            apiId,
            apiHash,
            sessionString,
            userAgent
        });

        const target = await resolveTarget(client, channelId);

        const deletedMessageIds = [];
        const failedMessageIds = [];

        for (const id of ids) {
            try {
                await client.deleteMessages(target, [id], {
                    revoke: true
                });

                deletedMessageIds.push(id);
            } catch (err) {
                console.error(
                    `Falha ao excluir mensagem ${id} no Telegram:`,
                    err.message
                );

                failedMessageIds.push({
                    messageId: id,
                    error: err.message || 'Falha na exclusão'
                });
            }
        }

        const success = failedMessageIds.length === 0;

        console.log('Resultado da exclusão no Telegram:', {
            solicitados: ids,
            excluidos: deletedMessageIds,
            falhas: failedMessageIds
        });

        return res.status(success ? 200 : 207).json({
            success,
            requestedCount: ids.length,
            deletedCount: deletedMessageIds.length,
            deletedMessageIds,
            failedMessageIds,
            message: success
                ? `Solicitada a exclusão de todas as ${ids.length} mensagem(ns).`
                : `${deletedMessageIds.length} de ${ids.length} mensagem(ns) processada(s). Algumas exclusões falharam.`
        });

    } catch (err) {
        console.error(
            'ERRO AO APAGAR MENSAGENS DO TELEGRAM:',
            err
        );

        return res.status(err.status || 500).json({
            success: false,
            message: err.message || 'Erro interno ao apagar mensagens.'
        });
    }
});

// ---------------------------------------------------------------------------
// 8. CANCELAR UPLOAD IMEDIATAMENTE
// ---------------------------------------------------------------------------

app.post('/api/upload/cancel', (req, res) => {
    const { uploadId } = req.body;
    const u = uploads[uploadId];

    if (!u) {
        return res.status(404).json({
            success: false,
            message: 'Upload não encontrado ou já finalizado.',
        });
    }

    // Marca o estado como cancelado para interromper os workers
    u.state = 'canceled';

    // Remove o arquivo temporário do disco imediatamente
    removeTemp(u);

    // Remove da lista de uploads ativos
    delete uploads[uploadId];

    console.log(`Upload ${uploadId} cancelado pelo usuário.`);

    return res.json({
        success: true,
        message: 'Upload cancelado com sucesso.',
    });
});

// ---------------------------------------------------------------------------
// INICIAR SERVIDOR
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
