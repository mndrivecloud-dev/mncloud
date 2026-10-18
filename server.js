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

// Configuração do Multer para armazenar temporariamente o arquivo na memória do servidor antes de enviar ao Telegram
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online!' });
});

const pendingLogins = {};

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

// Adicione um mapa global de sessões ativas no topo do server.js (junto com o pendingLogins)
const activeSessions = {};

// 2. Na rota de sign-in, salve a sessão ativa:
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { apiId, apiHash, phone, code, phoneCodeHash } = req.body;
        const pending = pendingLogins[phone];

        if (!pending) {
            return res.status(400).json({ success: false, message: 'Sessão expirada.' });
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
        
        // SALVA O CLIENTE AUTENTICADO NA MEMÓRIA PARA USO NO UPLOAD
        activeSessions[phone] = client;

        const me = await client.getMe();
        // ... (resto da lógica de canal) ...

        res.json({
            success: true,
            sessionString,
            chatId,
            channelName: 'MNDRIVE CLOUD',
            user: { id: me.id, username: me.username, phone: me.phone }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. Rota de Upload corrigida usando a sessão ativa do usuário
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const { phone, channelId, apiId, apiHash } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
        }

        // Pega o cliente já logado ou reconecta se necessário
        let client = activeSessions[phone];
        if (!client) {
            client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 5 });
            await client.connect();
            activeSessions[phone] = client;
        }

        const customFile = new CustomFile(file.originalname, file.size, '', file.buffer);
        const uploadedFile = await client.uploadFile(customFile, { workers: 2 });

        let target = channelId;
        if (target && target.startsWith('-100')) {
            target = await client.getEntity(Number(target));
        }

        const message = await client.sendFile(target || 'me', {
            file: uploadedFile,
            caption: `📦 MNDRIVE UPLOAD: ${file.originalname}`,
        });

        let fileId = message.media && message.media.document ? message.media.document.id.toString() : 'tg_file_' + Date.now();

        res.json({
            success: true,
            messageId: message.id,
            fileId: fileId
        });

    } catch (err) {
        console.error('Erro no upload para o Telegram:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
