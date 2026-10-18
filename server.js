const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ limit: '4gb', extended: true }));

// Configuração otimizada do Multer com limite de tamanho de 4GB por arquivo
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 * 1024 } // 4GB
});

app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online e operando!' });
});

const pendingLogins = {};
const activeSessions = {};

// 1. Enviar código de login
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

// 2. Confirmar o código de login
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

// 3. Rota de Upload de Ficheiros com Reutilização Estável de Sessão
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        console.log("Recebendo requisição de upload...");
        const { phone, channelId, apiId, apiHash, sessionString } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
        }

        console.log(`Arquivo recebido: ${file.originalname} (${file.size} bytes)`);

        // REUTILIZA O CLIENTE JÁ CONECTADO NA MEMÓRIA
        let client = activeSessions[phone];
        
        if (!client) {
            console.log("Criando nova sessão persistente na memória...");
            const stringSession = new StringSession(sessionString || '');
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { 
                connectionRetries: 5,
                useWSS: false // Garante estabilidade TCP full no Railway
            });
            await client.connect();
            activeSessions[phone] = client;
        } else {
            console.log("Utilizando cliente Telegram já ativo na memória.");
            // Garante que está conectado sem recriar a chave
            if (!client.connected) {
                await client.connect();
            }
        }

        console.log("Enviando arquivo para o Telegram...");

        const customFile = new CustomFile(
            file.originalname,
            file.size,
            undefined,
            file.buffer
        );

        const uploadResult = await client.uploadFile({
            file: customFile,
            workers: 4,
        });

        let target = channelId;
        if (target && String(target).startsWith('-100')) {
            try {
                target = await client.getEntity(Number(target));
            } catch (e) {
                console.warn("Não foi possível buscar a entidade pelo ID numérico, usando ID direto.");
            }
        }

        const message = await client.sendFile(target || 'me', {
            file: uploadResult,
            caption: `📦 MNDRIVE UPLOAD: ${file.originalname}`,
        });

        let fileId = message.media && message.media.document ? message.media.document.id.toString() : 'tg_file_' + Date.now();

        console.log("Upload concluído com sucesso no Telegram!");
        res.json({
            success: true,
            messageId: message.id,
            fileId: fileId
        });

    } catch (err) {
        console.error('ERRO DETALHADO NO UPLOAD:', err);
        
        // Se der erro de chave não registrada, limpa a sessão da memória para forçar renovação no próximo login
        if (err.errorMessage === 'AUTH_KEY_UNREGISTERED' && req.body.phone) {
            delete activeSessions[req.body.phone];
        }

        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
