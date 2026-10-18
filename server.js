const express = require('express');
const cors = require('cors');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ limit: '4gb', extended: true }));

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, os.tmpdir());
        },
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${file.originalname}`);
        }
    }),
    limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online e operando!' });
});

const pendingLogins = {};
const activeSessions = {};
const chunkUploads = {};

app.post('/api/auth/send-code', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;
        if (!apiId || !apiHash || !phone) {
            return res.status(400).json({ success: false, message: 'Parâmetros incompletos.' });
        }

        const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
            connectionRetries: 5,
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

app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { apiId, apiHash, phone, code, phoneCodeHash } = req.body;
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

        let chatId = targetChannel ? (targetChannel.id.toString().startsWith('-100') ? targetChannel.id.toString() : `-100${targetChannel.id}`) : me.id;
        delete pendingLogins[phone];

        res.json({
            success: true,
            sessionString,
            chatId,
            channelName: 'MNDRIVE CLOUD',
            user: { id: me.id, username: me.username, phone: me.phone }
        });
    } catch (err) {
        console.error('Erro ao autenticar código:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Rota de Upload por Partes Otimizada
app.post('/api/upload-chunk', upload.single('file'), async (req, res) => {
    req.socket.setTimeout(1800000);
    res.setTimeout(1800000);

    let uploadedFilePath = req.file ? req.file.path : null;

    try {
        const { phone, channelId, apiId, apiHash, sessionString, uploadSessionId, chunkIndex, totalChunks, fileName, fileSize } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum pedaço enviado.' });
        }

        if (!chunkUploads[uploadSessionId]) {
            chunkUploads[uploadSessionId] = {
                fileName,
                fileSize: Number(fileSize),
                totalChunks: Number(totalChunks),
                chunks: []
            };
        }

        chunkUploads[uploadSessionId].chunks[Number(chunkIndex)] = req.file.path;

        const session = chunkUploads[uploadSessionId];
        const receivedChunksCount = session.chunks.filter(p => p !== undefined).length;

        if (receivedChunksCount < session.totalChunks) {
            return res.json({ success: true, finished: false });
        }

        // --- TODAS AS PARTES CHEGARAM: UNINDO ARQUIVO SÍNCRONAMENTE ---
        console.log(`Todas as partes recebidas para ${fileName}. Unindo arquivo...`);
        const finalFilePath = path.join(os.tmpdir(), `merged_${Date.now()}_${fileName}`);
        
        const buffers = [];
        for (let chunkPath of session.chunks) {
            if (chunkPath && fs.existsSync(chunkPath)) {
                buffers.push(fs.readFileSync(chunkPath));
                try { fs.unlinkSync(chunkPath); } catch (e) {}
            }
        }
        
        fs.writeFileSync(finalFilePath, Buffer.concat(buffers));
        delete chunkUploads[uploadSessionId];

        if (!fs.existsSync(finalFilePath)) {
            throw new Error('Falha ao gerar o arquivo unificado no disco temporário.');
        }

        // RESPONDE IMEDIATAMENTE AO NAVEGADOR PARA EVITAR ERRO 502!
        res.json({
            success: true,
            finished: true,
            messageId: Date.now(), // ID temporário imediato
            fileId: 'tg_file_' + Date.now()
        });

        // --- ENVIO PARA O TELEGRAM EM SEGUNDO PLANO (BACKGROUND) ---
        setImmediate(async () => {
            try {
                let client = activeSessions[phone];
                if (!client) {
                    const stringSession = new StringSession(sessionString);
                    client = new TelegramClient(stringSession, Number(apiId), apiHash, { 
                        connectionRetries: 5, 
                        useWSS: false,
                        timeout: 60000 
                    });
                    await client.connect();
                    activeSessions[phone] = client;
                } else if (!client.connected) {
                    await client.connect();
                }

                console.log(`[Background] Enviando ${fileName} para o Telegram...`);
                const customFile = new CustomFile(fileName, Number(fileSize), finalFilePath);
                
                const uploadResult = await client.uploadFile({ 
                    file: customFile, 
                    workers: 1
                });

                let target = channelId;
                if (target && String(target).startsWith('-100')) {
                    try { target = await client.getEntity(Number(target)); } catch (e) {}
                }

                await client.sendFile(target || 'me', {
                    file: uploadResult,
                    caption: `📦 MNDRIVE UPLOAD: ${fileName}`,
                });

                console.log(`[Background] Arquivo ${fileName} enviado com sucesso para o Telegram!`);
            } catch (bgErr) {
                console.error('[Background Error] Falha ao enviar para o Telegram:', bgErr);
            } finally {
                if (fs.existsSync(finalFilePath)) {
                    try { fs.unlinkSync(finalFilePath); } catch (e) {}
                }
            }
        });

    } catch (err) {
        console.error('ERRO CRÍTICO NO UPLOAD POR PARTES:', err);
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
            try { fs.unlinkSync(uploadedFilePath); } catch (e) {}
        }
        if (!res.headersSent) {
            return res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
        }
    }
});

app.post('/api/delete-file', async (req, res) => {
    try {
        const { phone, channelId, apiId, apiHash, sessionString, messageId } = req.body;
        if (!messageId || !phone) {
            return res.status(400).json({ success: false, message: 'Parâmetros insuficientes.' });
        }

        let client = activeSessions[phone];
        if (!client) {
            if (!sessionString || sessionString === 'undefined') {
                return res.status(401).json({ success: false, message: 'Sessão inválida.' });
            }
            const stringSession = new StringSession(sessionString);
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { connectionRetries: 5, useWSS: false });
            await client.connect();
            activeSessions[phone] = client;
        } else if (!client.connected) {
            await client.connect();
        }

        let target = channelId;
        if (target && String(target).startsWith('-100')) {
            try { target = await client.getEntity(Number(target)); } catch (e) {}
        }

        await client.deleteMessages(target || 'me', [Number(messageId)], { revoke: true });
        res.json({ success: true, message: 'Apagado com sucesso.' });
    } catch (err) {
        console.error('ERRO AO APAGAR:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});

server.timeout = 1800000;
server.keepAliveTimeout = 60000;
