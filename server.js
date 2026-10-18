const express = require('express');
const cors = require('cors');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4gb' }));
app.use(express.urlencoded({ limit: '4gb', extended: true }));

// Rota de teste
app.get('/', (req, res) => {
    res.json({ success: true, message: 'MNDRIVE API no Railway está online!' });
});

// Armazenamento temporário em memória para sessões em progresso de login
const pendingLogins = {};

// 1. Enviar código de login para o Telegram
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
        const { phoneCodeHash } = await client.sendCode(
            { apiId: Number(apiId), apiHash },
            phone,
            false
        );

        pendingLogins[phone] = { client, phoneCodeHash };

        res.json({ success: true, phoneCodeHash });
    } catch (err) {
        console.error('Erro ao enviar código:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. Confirmar o código de login e verificar/criar o canal "MNDRIVE CLOUD"
app.post('/api/auth/sign-in', async (req, res) => {
    try {
        const { apiId, apiHash, phone, code, phoneCodeHash } = req.body;
        const pending = pendingLogins[phone];

        if (!pending) {
            return res.status(400).json({ success: false, message: 'Sessão expirada ou telefone não encontrado. Peça o código novamente.' });
        }

        const client = pending.client;

        await client.signIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash || pending.phoneCodeHash,
            phoneCode: code,
        });

        const sessionString = client.session.save();
        const me = await client.getMe();

        // Verificar se o canal "MNDRIVE CLOUD" já existe
        let targetChannel = null;
        const dialogs = await client.getDialogs({});
        
        for (const dialog of dialogs) {
            if (dialog.isChannel && dialog.title === 'MNDRIVE CLOUD') {
                targetChannel = dialog.entity;
                break;
            }
        }

        // Se não existir, cria o canal automaticamente
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
            user: {
                id: me.id,
                username: me.username,
                phone: me.phone
            }
        });

    } catch (err) {
        console.error('Erro ao autenticar código:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. Rota de Upload de Ficheiros para o canal
app.post('/api/upload', async (req, res) => {
    try {
        res.json({ success: true, message: 'Endpoint de upload pronto no Railway.' });
    } catch (err) {
        console.error('Erro no upload:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MNDRIVE API a executar na porta ${PORT}`);
});
