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

// 3. Rota de Upload de Arquivos 100% compatível com arquivos grandes (via diskStorage temporário)
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        console.log("Recebendo requisição de upload...");
        const { phone, channelId, apiId, apiHash, sessionString } = req.body;
        const file = req.file;

        if (!file) {
            console.warn("Nenhum arquivo encontrado no req.file");
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
        }

        console.log(`Arquivo recebido em disco: ${file.originalname} (${file.size} bytes) -> Caminho: ${file.path}`);

        let client = activeSessions[phone];
        
        if (!client) {
            console.log("Restaurando sessão do Telegram a partir da sessionString...");
            if (!sessionString || sessionString.trim() === '' || sessionString === 'undefined') {
                if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
                return res.status(401).json({ 
                    success: false, 
                    message: 'Sessão inválida. Por favor, faça login novamente no aplicativo.' 
                });
            }

            const stringSession = new StringSession(sessionString);
            client = new TelegramClient(stringSession, Number(apiId), apiHash, { 
                connectionRetries: 5,
                useWSS: false
            });
            await client.connect();
            activeSessions[phone] = client;
            console.log("Sessão restaurada e conectada com sucesso!");
        } else {
            console.log("Utilizando cliente Telegram já ativo na memória.");
            if (!client.connected) {
                await client.connect();
            }
        }

        console.log("Enviando arquivo para o Telegram a partir do caminho temporário...");

        // Usando o caminho real do arquivo em disco (/tmp) para o CustomFile do GramJS
        const customFile = new CustomFile(file.originalname, file.size, file.path);

        const uploadResult = await client.uploadFile({
            file: customFile,
            workers: 4, // 4 workers para máxima velocidade em arquivos grandes
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

        // Limpa o arquivo temporário do disco do Railway após o envio
        if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        let fileId = message.media && message.media.document ? message.media.document.id.toString() : 'tg_file_' + Date.now();

        console.log("Upload concluído com sucesso no Telegram e arquivo temporário limpo!");
        res.json({
            success: true,
            messageId: message.id,
            fileId: fileId
        });

    } catch (err) {
        console.error('ERRO DETALHADO NO UPLOAD:', err);
        
        // Garante a remoção do arquivo temporário mesmo em caso de falha
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (e) {}
        }

        if (err.errorMessage === 'AUTH_KEY_UNREGISTERED' && req.body.phone) {
            delete activeSessions[req.body.phone];
        }

        res.status(500).json({ success: false, message: err.message || 'Erro interno no servidor' });
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
            console.log("Restaurando sessão do Telegram para exclusão...");
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

        // Apaga a mensagem correspondente no canal do Telegram
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
