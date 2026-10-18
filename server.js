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

// Configuração do Multer para salvar temporariamente no diretório /tmp do sistema (100% compatível com o GramJS)
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, os.tmpdir());
        },
        filename: (req, file, cb) => {
            cb(null, `${Date.now()}-${file.originalname}`);
        }
    }),
    limits: { fileSize: 4 * 1024 * 1024 * 1024 } // Limite máximo de 4GB por upload
});

// Endpoint de saúde / teste da API
app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online e operando!' });
});

// Armazenamento em memória para sessões ativas e logins pendentes
const pendingLogins = {};
const activeSessions = {};
const chunkUploads = {}; // Armazenamento temporário para uploads fatiados

// 1. Rota para enviar o código de verificação via Telegram
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

// 2. Rota para confirmar o código de login e inicializar a sessão
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

// 3. Rota de Upload Tradicional (Mantida para compatibilidade)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    try {
        console.log("Recebendo requisição de upload tradicional...");
        const { phone, channelId, apiId, apiHash, sessionString } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
        }

        let client = activeSessions[phone];
        
        if (!client) {
            if (!sessionString || sessionString.trim() === '' || sessionString === 'undefined') {
                if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
                return res.status(401).json({ success: false, message: 'Sessão expirada. Reconecte a conta.' });
            }

            const stringSession = new StringSession(sessionString);
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { connectionRetries: 5, useWSS: false });
            await client.connect();
            await client.getMe();
            activeSessions[phone] = client;
        } else if (!client.connected) {
            await client.connect();
        }

        const customFile = new CustomFile(file.originalname, file.size, file.path);
        const uploadResult = await client.uploadFile({ file: customFile, workers: 2 });

        let target = channelId;
        if (target && String(target).startsWith('-100')) {
            try { target = await client.getEntity(Number(target)); } catch (e) {}
        }

        const message = await client.sendFile(target || 'me', {
            file: uploadResult,
            caption: `📦 MNDRIVE UPLOAD: ${file.originalname}`,
        });

        if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);

        let fileId = message.media && message.media.document ? message.media.document.id.toString() : 'tg_file_' + Date.now();

        res.json({ success: true, messageId: message.id, fileId: fileId });

    } catch (err) {
        console.error('ERRO NO UPLOAD:', err);
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    }
});

// 3.1 Rota de Upload por Partes (Chunks) - SOLUÇÃO DEFINITIVA PARA ARQUIVOS GRANDES SEM ERRO 502
app.post('/api/upload-chunk', upload.single('file'), async (req, res) => {
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    try {
        const { phone, channelId, apiId, apiHash, sessionString, uploadSessionId, chunkIndex, totalChunks, fileName, fileSize } = req.body;
        const file = req.file;

        if (!file) {
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

        chunkUploads[uploadSessionId].chunks[Number(chunkIndex)] = file.path;

        const session = chunkUploads[uploadSessionId];
        const receivedChunksCount = session.chunks.filter(p => p !== undefined).length;

        if (receivedChunksCount < session.totalChunks) {
            return res.json({ success: true, finished: false });
        }

        // Todas as partes chegaram: unir arquivo
        console.log(`Todas as partes recebidas para ${fileName}. Unindo arquivo...`);
        const finalFilePath = path.join(os.tmpdir(), `merged_${Date.now()}_${fileName}`);
        const writeStream = fs.createWriteStream(finalFilePath);

        for (let chunkPath of session.chunks) {
            const data = fs.readFileSync(chunkPath);
            writeStream.write(data);
            try { fs.unlinkSync(chunkPath); } catch (e) {}
        }
        writeStream.end();

        delete chunkUploads[uploadSessionId];

        let client = activeSessions[phone];
        if (!client) {
            const stringSession = new StringSession(sessionString);
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { connectionRetries: 5, useWSS: false });
            await client.connect();
            activeSessions[phone] = client;
        } else if (!client.connected) {
            await client.connect();
        }

        console.log("Enviando arquivo unificado para o Telegram...");
        const customFile = new CustomFile(fileName, Number(fileSize), finalFilePath);
        const uploadResult = await client.uploadFile({ file: customFile, workers: 2 });

        let target = channelId;
        if (target && String(target).startsWith('-100')) {
            try { target = await client.getEntity(Number(target)); } catch (e) {}
        }

        const message = await client.sendFile(target || 'me', {
            file: uploadResult,
            caption: `📦 MNDRIVE UPLOAD: ${fileName}`,
        });

        if (fs.existsSync(finalFilePath)) {
            fs.unlinkSync(finalFilePath);
        }

        let fileId = message.media && message.media.document ? message.media.document.id.toString() : 'tg_file_' + Date.now();

        console.log("Upload por partes concluído com sucesso!");
        return res.json({
            success: true,
            finished: true,
            messageId: message.id,
            fileId: fileId
        });

    } catch (err) {
        console.error('ERRO NO UPLOAD POR PARTES:', err);
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }
        return res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    }
});

// 4. Rota para apagar arquivo do Telegram (baseado no messageId)
app.post('/api/delete-file', async (req, res) => {
    try {
        console.log("Recebendo requisição para apagar arquivo...");
        const { phone, channelId, apiId, apiHash, sessionString, messageId } = req.body;

        if (!messageId || !phone) {
            return res.status(400).json({ success: false, message: 'Parâmetros insuficientes para exclusão.' });
        }

        let client = activeSessions[phone];
        
        if (!client) {
            if (!sessionString || sessionString.trim() === '' || sessionString === 'undefined') {
                return res.status(401).json({ success: false, message: 'Sessão inválida.' });
            }

            const stringSession = new StringSession(sessionString);
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { 
                connectionRetries: 5,
                useWSS: false
            });
            await client.connect();
            activeSessions[phone] = client;
        } else {
            if (!client.connected) {
                await client.connect();
            }
        }

        let target = channelId;
        if (target && String(target).startsWith('-100')) {
            try {
                target = await client.getEntity(Number(target));
            } catch (e) {
                console.warn("Usando target direto.");
            }
        }

        await client.deleteMessages(target || 'me', [Number(messageId)], { revoke: true });

        console.log(`Mensagem ${messageId} apagada com sucesso do Telegram!`);
        res.json({ success: true, message: 'Arquivo apagado do Telegram com sucesso.' });

    } catch (err) {
        console.error('ERRO DETALHADO AO APAGAR:', err);
        res.status(500).json({ success: false, message: err.message || 'Erro interno ao apagar' });
    }
});

// Inicialização do Servidor Express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
