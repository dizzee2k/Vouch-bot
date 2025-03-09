require('web-streams-polyfill');
require('dotenv').config();
const { Client, IntentsBitField, PermissionsBitField, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const express = require('express');

// Global error handlers
process.on('uncaughtException', (error) => {
    logError(`Uncaught Exception: ${error.message}\nStack: ${error.stack}`);
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    logError(`Unhandled Rejection at: ${promise}\nReason: ${reason.message || reason}\nStack: ${reason.stack || 'No stack trace'}`);
    console.error('Unhandled Rejection:', reason);
});

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint to keep dyno awake
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.send('Vouch Bot is running!'));
app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});

const VOUCH_CHANNEL_ID = '1306602749621698560'; // Hardcoded search channel (#vouch)
const OUTPUT_CHANNEL_ID = '1344063202643673128'; // Output channel (#vouch-check-command-center)
const GUILD_ID = '1242348592547496046'; // Hardcoded guild ID
const ROLE_TIER_DATA = [
    { roleId: '1339056153170284576', vouches: 3 },
    { roleId: '1339056251090243654', vouches: 5 },
    { roleId: '1339056315904954471', vouches: 30 }
];

const MOD_ROLE_ID = '1306596690903437323';
const OWNER_ROLE_ID = '1306596817588191274';

function loadVouchData() {
    try {
        const data = fs.readFileSync('vouchData.json', 'utf8');
        const parsedData = JSON.parse(data);
        console.log('Loaded vouch data:', parsedData);
        return new Map(parsedData);
    } catch (error) {
        console.log('No vouch data found, starting fresh:', error.message);
        return new Map();
    }
}

function saveVouchData(vouchCounts) {
    try {
        const dataToSave = [...vouchCounts];
        fs.writeFileSync('vouchData.json', JSON.stringify(dataToSave));
        console.log('Saved vouch data:', dataToSave);
    } catch (error) {
        console.error('Error saving vouch data:', error.message);
    }
}

function logError(message) {
    console.error(message);
    fs.appendFileSync('error.log', `${new Date().toISOString()} - ${message}\n`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const vouchCounts = loadVouchData();

async function getOutputChannel(guild, commandChannel = null) {
    try {
        const outputChannel = await client.channels.fetch(OUTPUT_CHANNEL_ID).catch(error => {
            logError(`Failed to fetch output channel ${OUTPUT_CHANNEL_ID}: ${error.message}`);
            return null;
        });

        if (!outputChannel || !outputChannel.isTextBased()) {
            throw new Error(`Output channel ${OUTPUT_CHANNEL_ID} is not a text channel or not found.`);
        }

        if (outputChannel.guild.id !== guild.id) {
            logError(`Output channel ${OUTPUT_CHANNEL_ID} does not belong to guild ${guild.id}. Falling back to command channel.`);
            return commandChannel || null;
        }

        const botMember = guild.members.me;
        const requiredPermissions = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages];
        const channelPermissions = botMember.permissionsIn(outputChannel);
        const missingPermissions = requiredPermissions.filter(perm => !channelPermissions.has(perm));
        if (missingPermissions.length > 0) {
            const missingPermNames = missingPermissions.map(perm => {
                for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
                    if (value === perm) return key;
                }
                return perm;
            }).join(', ');
            logError(`Bot lacks permissions in output channel ${outputChannel.name}: ${missingPermNames}`);
            throw new Error(`Bot lacks permissions in output channel ${outputChannel.name}: ${missingPermNames}.`);
        }

        console.log(`Output channel set to: ${outputChannel.name} (ID: ${outputChannel.id})`);
        return outputChannel;
    } catch (error) {
        logError(`Error setting output channel: ${error.message}`);
        if (commandChannel) {
            await commandChannel.send(`Could not use output channel <#${OUTPUT_CHANNEL_ID}>: ${error.message}. Using command channel for responses.`);
        }
        return commandChannel || null;
    }
}

async function findChannel(guild, channelId) {
    if (!guild) throw new Error('Guild not found. Ensure the bot is in the correct server.');
    console.log(`Searching for channel with ID: ${channelId}`);

    const channel = await client.channels.fetch(channelId).catch(error => {
        logError(`Failed to fetch channel by ID ${channelId}: ${error.message}`);
        return null;
    });

    if (channel && channel.isTextBased()) {
        console.log(`Found channel by ID: ${channel.name} (ID: ${channel.id})`);
        return channel;
    }

    throw new Error(`Could not find channel '${channelId}'. Ensure the channel exists, is text-based, and the bot has access.`);
}

async function countMentionsInChannel(searchChannel, guild, targetUserId = null) {
    try {
        if (!searchChannel || !searchChannel.isTextBased()) {
            throw new Error(`Search channel is not defined or not text-based. Ensure ${searchChannel?.id || 'unknown'} is a text channel.`);
        }

        const botMember = guild.members.me;
        const requiredPermissions = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.SendMessages
        ];
        const channelPermissions = botMember.permissionsIn(searchChannel);
        const missingPermissions = requiredPermissions.filter(perm => !channelPermissions.has(perm));
        if (missingPermissions.length > 0) {
            const missingPermNames = missingPermissions.map(perm => {
                for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
                    if (value === perm) return key;
                }
                return perm;
            }).join(', ');
            logError(`Bot lacks permissions in channel ${searchChannel.id}: Missing ${missingPermNames}`);
            throw new Error(`Bot lacks the following permissions in search channel ${searchChannel.name}: ${missingPermNames}.`);
        }
        console.log(`Bot has required permissions in search channel ${searchChannel.id}: ViewChannel, ReadMessageHistory, SendMessages`);

        console.log(`Attempting to fetch messages from search channel ${searchChannel.id} (Name: ${searchChannel.name})`);

        let members;
        try {
            console.log(`Attempting to fetch members for guild ${guild.id} with ${guild.memberCount} members`);
            members = await guild.members.fetch();
            console.log(`Successfully fetched ${members.size} members`);
            await delay(500);
        } catch (error) {
            logError(`Failed to fetch guild members: ${error.message}`);
            members = guild.members.cache;
            console.log(`Falling back to cached members. Total cached members: ${members.size}`);
        }
        const memberIds = new Set(members.keys());

        let messages = new Map();
        let lastId = null;
        let totalMessages = 0;
        const maxMessages = 1000;

        while (totalMessages < maxMessages) {
            const fetchOptions = { limit: 50 };
            if (lastId) fetchOptions.before = lastId;

            const newMessages = await searchChannel.messages.fetch(fetchOptions).catch(error => {
                logError(`Failed to fetch messages: ${error.message}`);
                throw new Error(`Failed to fetch messages: ${error.message}`);
            });

            if (newMessages.size === 0) break;

            newMessages.forEach(msg => messages.set(msg.id, msg));
            totalMessages += newMessages.size;
            lastId = newMessages.last()?.id;

            console.log(`Fetched ${newMessages.size} messages, total: ${totalMessages}`);
            await delay(500);
        }

        console.log(`Fetched ${totalMessages} messages in search channel ${searchChannel.id}`);

        let mentionCount = 0;
        messages.forEach(message => {
            if (message.author.bot) return;

            const mentions = new Set();
            message.mentions.users.forEach(user => mentions.add(user.id));

            const rawMentions = message.content.match(/<@!?(\d+)>/g);
            if (rawMentions) {
                rawMentions.forEach(mention => {
                    const userId = mention.match(/<@!?(\d+)>/)[1];
                    mentions.add(userId);
                });
            }

            mentions.forEach(userId => {
                if (memberIds.has(userId)) {
                    if (!targetUserId || userId === targetUserId) {
                        mentionCount++;
                        console.log(`Counted mention for user ${userId} in message ${message.id}`);
                    }
                }
            });
        });

        return { totalMessages, mentionCount };
    } catch (error) {
        logError(`Failed to count mentions in search channel ${searchChannel?.id || 'unknown'}: ${error.message}`);
        throw error;
    }
}

async function processMentionsInChannel(searchChannel, guild, targetUserId = null, commandChannel = null) {
    let outputChannel;
    try {
        outputChannel = await getOutputChannel(guild, commandChannel);
        if (!outputChannel) {
            throw new Error('No valid output channel available.');
        }
    } catch (error) {
        logError(`Cannot proceed without output channel: ${error.message}`);
        return;
    }

    try {
        if (!searchChannel || !searchChannel.isTextBased()) {
            throw new Error(`Search channel is not defined or not text-based. Ensure ${searchChannel?.id || 'unknown'} is a text channel.`);
        }

        const botMember = guild.members.me;
        const requiredPermissions = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.SendMessages
        ];
        const channelPermissions = botMember.permissionsIn(searchChannel);
        const missingPermissions = requiredPermissions.filter(perm => !channelPermissions.has(perm));
        if (missingPermissions.length > 0) {
            const missingPermNames = missingPermissions.map(perm => {
                for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
                    if (value === perm) return key;
                }
                return perm;
            }).join(', ');
            logError(`Bot lacks permissions in channel ${searchChannel.id}: Missing ${missingPermNames}`);
            throw new Error(`Bot lacks the following permissions in search channel ${searchChannel.name}: ${missingPermNames}.`);
        }
        console.log(`Bot has required permissions in search channel ${searchChannel.id}: ViewChannel, ReadMessageHistory, SendMessages`);

        console.log(`Attempting to fetch messages from search channel ${searchChannel.id} (Name: ${searchChannel.name})`);

        let members;
        try {
            console.log(`Attempting to fetch members for guild ${guild.id} with ${guild.memberCount} members`);
            members = await guild.members.fetch();
            console.log(`Successfully fetched ${members.size} members`);
            await delay(500);
        } catch (error) {
            logError(`Failed to fetch guild members: ${error.message}`);
            members = guild.members.cache;
            console.log(`Falling back to cached members. Total cached members: ${members.size}`);
        }
        const memberIds = new Set(members.keys());

        let messages = new Map();
        let lastId = null;
        let totalMessages = 0;
        const maxMessages = 1000;

        while (totalMessages < maxMessages) {
            const fetchOptions = { limit: 50 };
            if (lastId) fetchOptions.before = lastId;

            const newMessages = await searchChannel.messages.fetch(fetchOptions).catch(error => {
                logError(`Failed to fetch messages: ${error.message}`);
                throw new Error(`Failed to fetch messages: ${error.message}`);
            });

            if (newMessages.size === 0) break;

            newMessages.forEach(msg => messages.set(msg.id, msg));
            totalMessages += newMessages.size;
            lastId = newMessages.last()?.id;

            console.log(`Fetched ${newMessages.size} messages, total: ${totalMessages}`);
            await delay(500);
        }

        console.log(`Fetched ${totalMessages} messages in search channel ${searchChannel.id}`);
        await outputChannel.send(`Fetched ${totalMessages} messages in channel ${searchChannel.name} for vouch search.`);

        let mentionCount = 0;

        messages.forEach(message => {
            if (message.author.bot) return;

            const mentions = new Set();
            message.mentions.users.forEach(user => mentions.add(user.id));

            const rawMentions = message.content.match(/<@!?(\d+)>/g);
            if (rawMentions) {
                rawMentions.forEach(mention => {
                    const userId = mention.match(/<@!?(\d+)>/)[1];
                    mentions.add(userId);
                });
            }

            mentions.forEach(userId => {
                if (memberIds.has(userId)) {
                    if (!targetUserId || userId === targetUserId) {
                        const currentCount = vouchCounts.get(userId) || 0;
                        if (currentCount < 50) {
                            vouchCounts.set(userId, currentCount + 1);
                            mentionCount++;
                            console.log(`Counted mention for user ${userId} in message ${message.id}`);
                        }
                    }
                }
            });
        });

        if (mentionCount > 0) {
            console.log(`Found ${mentionCount} unique explicit @mentions in search channel ${searchChannel.id} for ${targetUserId ? 'target user' : 'all server members'}`);
            await outputChannel.send(`Found ${mentionCount} unique explicit @mentions in channel ${searchChannel.name} for ${targetUserId ? `<@${targetUserId}>` : 'all server members'}.`);
        } else {
            console.log(`No explicit @mentions found in search channel ${searchChannel.id} for ${targetUserId ? 'target user' : 'all server members'}`);
            await outputChannel.send(`No explicit @mentions found in channel ${searchChannel.name} for ${targetUserId ? `<@${targetUserId}>` : 'all server members'}.`);
        }

        if (targetUserId) {
            const member = guild.members.cache.get(targetUserId) || await guild.members.fetch(targetUserId).catch(() => null);
            if (member) {
                const count = vouchCounts.get(targetUserId) || 0;
                const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
                const highestThreshold = ROLE_TIER_DATA.filter(t => count >= t.vouches).pop();

                if (highestThreshold) {
                    for (const oldRoleId of currentRoles) {
                        if (oldRoleId !== highestThreshold.roleId && member.roles.cache.has(oldRoleId)) {
                            await member.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                            await delay(500);
                        }
                    }
                    if (!member.roles.cache.has(highestThreshold.roleId)) {
                        await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
                        await outputChannel.send(`<@${member.user.id}> now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                        await delay(500);
                    } else {
                        await outputChannel.send(`<@${member.user.id}> now has ${count} vouch${count === 1 ? '' : 'es'}.`);
                        await delay(500);
                    }
                } else {
                    for (const role of ROLE_TIER_DATA) {
                        if (member.roles.cache.has(role.roleId)) {
                            await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await delay(500);
                        }
                    }
                }
            }
        } else {
            for (const [userId, count] of vouchCounts) {
                const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
                    const highestThreshold = ROLE_TIER_DATA.filter(t => count >= t.vouches).pop();

                    if (highestThreshold) {
                        for (const oldRoleId of currentRoles) {
                            if (oldRoleId !== highestThreshold.roleId && member.roles.cache.has(oldRoleId)) {
                                await member.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                                await delay(500);
                            }
                        }
                        if (!member.roles.cache.has(highestThreshold.roleId)) {
                            await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
                            await outputChannel.send(`<@${member.user.id}> now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                            await delay(500);
                        }
                    } else {
                        for (const role of ROLE_TIER_DATA) {
                            if (member.roles.cache.has(role.roleId)) {
                                await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                                await delay(500);
                            }
                        }
                    }
                }
            }
        }

        saveVouchData(vouchCounts);
        console.log(`Processed explicit @mentions in search channel ${searchChannel.id}, updated vouch counts and roles for ${targetUserId ? `user ${targetUserId}` : 'all server members'}.`);
        await outputChannel.send('Vouch counts and roles have been updated based on explicit @mentions in the vouch channel.');
    } catch (error) {
        logError(`Failed to process mentions in search channel ${searchChannel?.id || 'unknown'}: ${error.message}`);
        const errorMessage = error.message.includes('Bot lacks the following permissions')
            ? error.message
            : `There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the channel name/ID is correct.`;
        await outputChannel?.send(errorMessage);
        if (commandChannel) {
            await commandChannel.send(`An error occurred while processing vouches. Check the output in <#${OUTPUT_CHANNEL_ID}> for details or see logs: ${error.message}`);
        }
    }
}

client.once('ready', async () => {
    console.log('Vouch Bot is online!');
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Intents enabled:', client.options.intents.bitfield.toString());
    console.log('Bot is in the following guilds:', client.guilds.cache.map(g => ({ id: g.id, name: g.name })));

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('vouchsearch')
            .setDescription('Search for vouches for a specific user')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to search vouches for')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('vouch')
            .setDescription('Vouch for a user')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to vouch for')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('vouches')
            .setDescription('Check vouch count for a user')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to check vouches for')
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('vouchreset')
            .setDescription('Reset all vouch counts and roles (Mod only)'),
        new SlashCommandBuilder()
            .setName('vouchwipe')
            .setDescription('Wipe all vouch counts and roles (Owner only)'),
        new SlashCommandBuilder()
            .setName('unvouch')
            .setDescription('Remove a vouch from a user (Mod only)')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to remove a vouch from')
                    .setRequired(true)
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        logError(`Failed to register slash commands: ${error.message}`);
        console.error(error);
    }

    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server with ID ${GUILD_ID}.`);
        }

        const searchChannel = await client.channels.fetch(VOUCH_CHANNEL_ID).catch(error => {
            logError(`Failed to fetch search channel ${VOUCH_CHANNEL_ID}: ${error.message}`);
            return null;
        });
        if (!searchChannel || !searchChannel.isTextBased()) {
            throw new Error(`Search channel ${VOUCH_CHANNEL_ID} is not a text channel or not found.`);
        }

        const outputChannel = await getOutputChannel(guild);
        if (outputChannel) {
            await outputChannel.send('Vouch Bot is online and ready to track vouches based on explicit @mentions in #vouch! Use `/vouchsearch @user` to check vouches for a specific user.');
        } else {
            console.log('No output channel available, skipping startup message.');
        }

        setTimeout(async () => {
            try {
                await processMentionsInChannel(searchChannel, guild);
            } catch (error) {
                logError(`Deferred processMentionsInChannel failed: ${error.message}`);
                if (outputChannel) {
                    await outputChannel.send(`Failed to process mentions on startup: ${error.message}. The bot is still running, but please check permissions or channel settings.`);
                }
            }
        }, 5000);
    } catch (error) {
        logError(`Failed to send startup message: ${error.message}`);
        console.log(`Error sending startup message: ${error.message}`);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;
    console.log(`Received slash command: ${commandName} from ${interaction.user.tag} in channel ${interaction.channelId}`);

    if (commandName === 'vouchsearch') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
            await interaction.reply({ content: 'Only the owner can use this command.', ephemeral: true });
            console.log('Slash command denied: User lacks OWNER_ROLE_ID');
            return;
        }

        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            const targetUser = interaction.options.getUser('user');
            if (!targetUser) {
                throw new Error('No user specified. Please select a user.');
            }

            const targetUserId = targetUser.id;
            if (!guild.members.cache.has(targetUserId)) {
                throw new Error(`User ${targetUser.tag} is not a member of this server.`);
            }

            let searchChannel = await client.channels.fetch(VOUCH_CHANNEL_ID).catch(error => {
                throw new Error(`Failed to fetch search channel ${VOUCH_CHANNEL_ID}: ${error.message}`);
            });

            const { totalMessages, mentionCount } = await countMentionsInChannel(searchChannel, guild, targetUserId);
            await interaction.editReply(`Fetched ${totalMessages} messages in channel ${searchChannel.name}. Found ${mentionCount} unique explicit @mentions for <@${targetUserId}> in #vouch.`);
            console.log(`Successfully processed slash command vouchsearch for ${targetUser.tag}`);
        } catch (error) {
            logError(`Failed to process slash command vouchsearch: ${error.message}`);
            await interaction.editReply(`There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the user is correct.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }

    if (commandName === 'vouch') {
        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            const targetUser = interaction.options.getUser('user');
            if (!targetUser) {
                throw new Error('No user specified. Please select a user.');
            }

            const targetUserId = targetUser.id;
            if (!guild.members.cache.has(targetUserId)) {
                throw new Error(`User ${targetUser.tag} is not a member of this server.`);
            }

            const currentCount = vouchCounts.get(targetUserId) || 0;
            if (currentCount >= 50) {
                throw new Error(`User ${targetUser.tag} has reached the maximum vouch count of 50.`);
            }

            vouchCounts.set(targetUserId, currentCount + 1);
            saveVouchData(vouchCounts);

            const member = guild.members.cache.get(targetUserId);
            const count = vouchCounts.get(targetUserId);
            const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
            const highestThreshold = ROLE_TIER_DATA.filter(t => count >= t.vouches).pop();

            let roleMessage = '';
            if (highestThreshold) {
                for (const oldRoleId of currentRoles) {
                    if (oldRoleId !== highestThreshold.roleId && member.roles.cache.has(oldRoleId)) {
                        await member.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                        await delay(500);
                    }
                }
                if (!member.roles.cache.has(highestThreshold.roleId)) {
                    await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
                    roleMessage = ` and earned the <@&${highestThreshold.roleId}> role!`;
                    await delay(500);
                }
            } else {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await delay(500);
                    }
                }
            }

            await interaction.editReply(`Vouched for <@${targetUserId}>! They now have ${count} vouch${count === 1 ? '' : 'es'}${roleMessage}`);
            console.log(`Successfully processed slash command vouch for ${targetUser.tag}`);
        } catch (error) {
            logError(`Failed to process slash command vouch: ${error.message}`);
            await interaction.editReply(`There was an issue vouching: ${error.message}.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }

    if (commandName === 'vouches') {
        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            const targetUser = interaction.options.getUser('user');
            if (!targetUser) {
                throw new Error('No user specified. Please select a user.');
            }

            const targetUserId = targetUser.id;
            if (!guild.members.cache.has(targetUserId)) {
                throw new Error(`User ${targetUser.tag} is not a member of this server.`);
            }

            const count = vouchCounts.get(targetUserId) || 0;
            await interaction.editReply(`<@${targetUserId}> has ${count} vouch${count === 1 ? '' : 'es'}.`);
            console.log(`Successfully processed slash command vouches for ${targetUser.tag}`);
        } catch (error) {
            logError(`Failed to process slash command vouches: ${error.message}`);
            await interaction.editReply(`There was an issue checking vouches: ${error.message}.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }

    if (commandName === 'vouchreset') {
        if (!interaction.member.roles.cache.has(MOD_ROLE_ID)) {
            await interaction.reply({ content: 'Only moderators can use this command.', ephemeral: true });
            console.log('Slash command denied: User lacks MOD_ROLE_ID');
            return;
        }

        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            for (const [userId] of vouchCounts) {
                const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    for (const role of ROLE_TIER_DATA) {
                        if (member.roles.cache.has(role.roleId)) {
                            await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await delay(500);
                        }
                    }
                }
            }

            vouchCounts.clear();
            saveVouchData(vouchCounts);
            await interaction.editReply('All vouch counts and roles have been reset.');
            console.log('Successfully processed slash command vouchreset');
        } catch (error) {
            logError(`Failed to process slash command vouchreset: ${error.message}`);
            await interaction.editReply(`There was an issue resetting vouches: ${error.message}.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }

    if (commandName === 'vouchwipe') {
        if (!interaction.member.roles.cache.has(OWNER_ROLE_ID)) {
            await interaction.reply({ content: 'Only the owner can use this command.', ephemeral: true });
            console.log('Slash command denied: User lacks OWNER_ROLE_ID');
            return;
        }

        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            for (const [userId] of vouchCounts) {
                const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    for (const role of ROLE_TIER_DATA) {
                        if (member.roles.cache.has(role.roleId)) {
                            await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await delay(500);
                        }
                    }
                }
            }

            vouchCounts.clear();
            saveVouchData(vouchCounts);
            await interaction.editReply('All vouch counts and roles have been wiped.');
            console.log('Successfully processed slash command vouchwipe');
        } catch (error) {
            logError(`Failed to process slash command vouchwipe: ${error.message}`);
            await interaction.editReply(`There was an issue wiping vouches: ${error.message}.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }

    if (commandName === 'unvouch') {
        if (!interaction.member.roles.cache.has(MOD_ROLE_ID)) {
            await interaction.reply({ content: 'Only moderators can use this command.', ephemeral: true });
            console.log('Slash command denied: User lacks MOD_ROLE_ID');
            return;
        }

        await interaction.deferReply();

        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) throw new Error(`Guild ${GUILD_ID} not found. Ensure the bot is in the correct server.`);

            const targetUser = interaction.options.getUser('user');
            if (!targetUser) {
                throw new Error('No user specified. Please select a user.');
            }

            const targetUserId = targetUser.id;
            if (!guild.members.cache.has(targetUserId)) {
                throw new Error(`User ${targetUser.tag} is not a member of this server.`);
            }

            const currentCount = vouchCounts.get(targetUserId) || 0;
            if (currentCount <= 0) {
                throw new Error(`User ${targetUser.tag} has no vouches to remove.`);
            }

            const newCount = currentCount - 1;
            vouchCounts.set(targetUserId, newCount);
            saveVouchData(vouchCounts);

            const member = guild.members.cache.get(targetUserId);
            const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
            const highestThreshold = ROLE_TIER_DATA.filter(t => newCount >= t.vouches).pop();

            if (highestThreshold) {
                for (const oldRoleId of currentRoles) {
                    if (oldRoleId !== highestThreshold.roleId && member.roles.cache.has(oldRoleId)) {
                        await member.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                        await delay(500);
                    }
                }
                if (!member.roles.cache.has(highestThreshold.roleId)) {
                    await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
                    await delay(500);
                }
            } else {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await delay(500);
                    }
                }
            }

            await interaction.editReply(`Removed a vouch from <@${targetUserId}>. They now have ${newCount} vouch${newCount === 1 ? '' : 'es'}.`);
            console.log(`Successfully processed slash command unvouch for ${targetUser.tag}`);
        } catch (error) {
            logError(`Failed to process slash command unvouch: ${error.message}`);
            await interaction.editReply(`There was an issue removing a vouch: ${error.message}.`);
            console.log(`Error handled for slash command: ${error.message}`);
        }
    }
});

client.on('error', error => {
    logError(`Discord client error: ${error.message}`);
    console.log('Attempting to reconnect...');
});

client.on('disconnected', () => {
    logError('Bot disconnected from Discord. Attempting to reconnect...');
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login. Please check your DISCORD_TOKEN.');
    console.error('Error details:', error.message);
    if (!process.env.DISCORD_TOKEN) logError('DISCORD_TOKEN is missing in environment variables.');
});
