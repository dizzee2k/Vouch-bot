require('web-streams-polyfill');
require('dotenv').config();
const { Client, IntentsBitField, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const express = require('express');

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
app.get('/', (req, res) => res.send('Vouch Bot is running!'));
app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});

const DEFAULT_VOUCH_CHANNEL_NAME = 'vouch';
const VOUCH_CHANNEL_ID = '1306602749621698560';
const ROLE_TIER_DATA = [
    { roleId: '1339056153170284576', vouches: 3 }, // Verify and update these IDs
    { roleId: '1339056251090243654', vouches: 15 },
    { roleId: '1339056315904954471', vouches: 30 } // Fix 5: Double-check this ID
];

const MOD_ROLE_ID = '1306596690903437323';
const OWNER_ROLE_ID = '1306596817588191274';

// Fix 1 & 2: Define and register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('vouch')
        .setDescription('Vouch for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to vouch for')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('vouches')
        .setDescription('Check vouch count for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check vouches for')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('vouchsearch')
        .setDescription('Search for vouches in a channel (Owner only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to search vouches for')
                .setRequired(true))
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The channel to search in')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('unvouch')
        .setDescription('Remove a vouch from a user (Mod only)')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to remove a vouch from')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('vouchreset')
        .setDescription('Reset all vouch counts and roles (Mod only)'),
    new SlashCommandBuilder()
        .setName('vouchwipe')
        .setDescription('Wipe all vouch counts and roles (Owner only)')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerSlashCommands() {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID), // Ensure CLIENT_ID is in .env
            { body: commands }
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}

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

const vouchCounts = loadVouchData();

async function findChannel(guild, channelMentionOrName) {
    if (!guild) throw new Error('Guild not found. Ensure the bot is in the correct server.');
    console.log(`Searching for channel: ${channelMentionOrName || 'default vouch channel'}`);

    let channel = null;
    if (channelMentionOrName && channelMentionOrName.match(/<#(\d+)>/)) {
        const channelId = channelMentionOrName.match(/<#(\d+)>/)[1];
        channel = await client.channels.fetch(channelId).catch(error => {
            logError(`Failed to fetch channel by ID ${channelId}: ${error.message}`);
            return null;
        });
    } else if (VOUCH_CHANNEL_ID) {
        channel = await client.channels.fetch(VOUCH_CHANNEL_ID).catch(error => {
            logError(`Failed to fetch default channel by ID ${VOUCH_CHANNEL_ID}: ${error.message}`);
            return null;
        });
    }

    if (channel && channel.isTextBased()) {
        console.log(`Found channel by ID: ${channel.name} (ID: ${channel.id})`);
        return channel;
    }

    if (channelMentionOrName) {
        const cleanChannelName = channelMentionOrName.replace(/^#/, '').toLowerCase();
        channel = guild.channels.cache.find(c => c.name.toLowerCase() === cleanChannelName && c.isTextBased());
        if (channel) {
            console.log(`Found channel by name: ${channel.name} (ID: ${channel.id})`);
            return channel;
        }
    }

    channel = guild.channels.cache.find(c => c.name.toLowerCase() === DEFAULT_VOUCH_CHANNEL_NAME && c.isTextBased());
    if (channel) {
        console.log(`Falling back to default vouch channel: ${channel.name} (ID: ${channel.id})`);
        return channel;
    }

    const textChannels = guild.channels.cache.filter(c => c.isTextBased());
    console.log('Available text channels in guild:', textChannels.map(c => `${c.name} (ID: ${c.id})`).join(', '));
    throw new Error(`Could not find channel '${channelMentionOrName || DEFAULT_VOUCH_CHANNEL_NAME}'. Ensure the channel exists, is text-based, and the bot has access.`);
}

async function processMentionsInChannel(channel, guild, targetUserId = null) {
    try {
        if (!channel || !channel.isTextBased()) {
            throw new Error(`Channel is not defined or not text-based. Ensure ${channel?.id || 'unknown'} is a text channel.`);
        }

        const botMember = guild.members.me;
        const requiredPermissions = [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.SendMessages
        ];
        const channelPermissions = botMember.permissionsIn(channel);
        const missingPermissions = requiredPermissions.filter(perm => !channelPermissions.has(perm));
        if (missingPermissions.length > 0) {
            const missingPermNames = missingPermissions.map(perm => {
                for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
                    if (value === perm) return key;
                }
                return perm;
            });
            console.log(`Bot lacks permissions in channel ${channel.id}: Missing ${missingPermNames.join(', ')}`);
            throw new Error(`Bot lacks the following permissions in channel ${channel.name}: ${missingPermNames.join(', ')}. Please grant these permissions to the bot.`);
        }
        console.log(`Bot has required permissions in channel ${channel.id}: ViewChannel, ReadMessageHistory, SendMessages`);

        console.log(`Attempting to fetch messages from channel ${channel.id} (Name: ${channel.name})`);

        let members;
        try {
            console.log(`Attempting to fetch members for guild ${guild.id} with ${guild.memberCount} members`);
            members = await guild.members.fetch();
            console.log(`Successfully fetched ${members.size} members`);
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
            const fetchOptions = { limit: 100 };
            if (lastId) fetchOptions.before = lastId;

            const newMessages = await channel.messages.fetch(fetchOptions).catch(error => {
                logError(`Failed to fetch messages: ${error.message}`);
                throw new Error(`Failed to fetch messages: ${error.message}`);
            });

            if (newMessages.size === 0) break;

            newMessages.forEach(msg => messages.set(msg.id, msg));
            totalMessages += newMessages.size;
            lastId = newMessages.last()?.id;

            console.log(`Fetched ${newMessages.size} messages, total: ${totalMessages}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`Fetched ${totalMessages} messages in channel ${channel.id}`);
        await channel.send(`Fetched ${totalMessages} messages in channel ${channel.name} for vouch search.`);

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
            console.log(`Found ${mentionCount} unique explicit @mentions in channel ${channel.id} for ${targetUserId ? 'target user' : 'all server members'}`);
            await channel.send(`Found ${mentionCount} unique explicit @mentions in channel ${channel.name} for ${targetUserId ? `<@${targetUserId}>` : 'all server members'}.`);
        } else {
            console.log(`No explicit @mentions found in channel ${channel.id} for ${targetUserId ? 'target user' : 'all server members'}`);
            await channel.send(`No explicit @mentions found in channel ${channel.name} for ${targetUserId ? `<@${targetUserId}>` : 'all server members'}.`);
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
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    const roleToAdd = guild.roles.cache.get(highestThreshold.roleId);
                    if (!roleToAdd) {
                        throw new Error(`Role ${highestThreshold.roleId} not found in guild. Please update ROLE_TIER_DATA with correct role IDs.`);
                    }
                    if (!member.roles.cache.has(highestThreshold.roleId)) {
                        await member.roles.add(highestThreshold.roleId).catch(error => {
                            logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`);
                            throw error;
                        });
                        await channel.send(`${member.user.tag} now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                    } else {
                        await channel.send(`${member.user.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
                    }
                } else {
                    for (const role of ROLE_TIER_DATA) {
                        if (member.roles.cache.has(role.roleId)) {
                            await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await new Promise(resolve => setTimeout(resolve, 500));
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
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        }
                        const roleToAdd = guild.roles.cache.get(highestThreshold.roleId);
                        if (!roleToAdd) {
                            throw new Error(`Role ${highestThreshold.roleId} not found in guild. Please update ROLE_TIER_DATA with correct role IDs.`);
                        }
                        if (!member.roles.cache.has(highestThreshold.roleId)) {
                            await member.roles.add(highestThreshold.roleId).catch(error => {
                                logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`);
                                throw error;
                            });
                            await channel.send(`${member.user.tag} now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                        }
                    } else {
                        for (const role of ROLE_TIER_DATA) {
                            if (member.roles.cache.has(role.roleId)) {
                                await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        }
                    }
                }
            }
        }

        saveVouchData(vouchCounts);
        console.log(`Processed explicit @mentions in channel ${channel.id}, updated vouch counts and roles for ${targetUserId ? `user ${targetUserId}` : 'all server members'}.`);
        await channel.send('Vouch counts and roles have been updated based on explicit @mentions in the vouch channel.');
    } catch (error) {
        logError(`Failed to process mentions in channel ${channel?.id || 'unknown'}: ${error.message}`);
        const errorMessage = error.message.includes('Bot lacks the following permissions')
            ? error.message
            : `There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the channel name/ID is correct.`;
        await channel?.send(errorMessage);
    }
}

client.once('ready', async () => {
    console.log('Vouch Bot is online!');
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Invite Link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=274878262272&scope=bot%20applications.commands`);

    await registerSlashCommands();

    try {
        const guild = client.guilds.cache.first();
        if (!guild) {
            throw new Error('No guild found. Ensure the bot is in a server.');
        }

        const channel = await findChannel(guild, DEFAULT_VOUCH_CHANNEL_NAME);
        await channel.send('Vouch Bot is online and ready to track vouches based on explicit @mentions!');

        setTimeout(async () => {
            try {
                await processMentionsInChannel(channel, guild);
            } catch (error) {
                logError(`Deferred processMentionsInChannel failed: ${error.message}`);
                await channel.send(`Failed to process mentions on startup: ${error.message}. The bot is still running, but please check permissions or channel settings.`);
            }
        }, 5000);
    } catch (error) {
        logError(`Failed to send startup message: ${error.message}`);
        console.log(`Error sending startup message: ${error.message}`);
    }
});

// Fix 1: Complete slash command handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    // Fix 4 & 6: Add logging for interactions
    console.log(`Received slash command: ${interaction.commandName} from user ${interaction.user.tag} in channel ${interaction.channel.name} (ID: ${interaction.channel.id})`);

    const botMember = interaction.guild.members.me;
    const requiredPermissions = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages
    ];
    const channelPermissions = botMember.permissionsIn(interaction.channel);
    const missingPermissions = requiredPermissions.filter(perm => !channelPermissions.has(perm));
    if (missingPermissions.length > 0) {
        const missingPermNames = missingPermissions.map(perm => {
            for (const [key, value] of Object.entries(PermissionsBitField.Flags)) {
                if (value === perm) return key;
            }
            return perm;
        });
        console.log(`Bot lacks permissions in channel ${interaction.channel.id}: Missing ${missingPermNames.join(', ')}`);
        return interaction.reply({
            content: `I lack the following permissions in this channel: ${missingPermNames.join(', ')}. Please grant these permissions to the bot.`,
            ephemeral: true
        });
    }

    try {
        if (interaction.commandName === 'vouch') {
            const mentionedUser = interaction.options.getUser('user');
            if (!mentionedUser) {
                return interaction.reply({ content: 'Please mention a user to vouch for with an @mention!', ephemeral: true });
            }
            if (mentionedUser.id === interaction.user.id) {
                return interaction.reply({ content: 'You can’t vouch for yourself!', ephemeral: true });
            }

            const count = (vouchCounts.get(mentionedUser.id) || 0) + 1;
            vouchCounts.set(mentionedUser.id, count);
            saveVouchData(vouchCounts);

            const member = interaction.guild.members.cache.get(mentionedUser.id) || await interaction.guild.members.fetch(mentionedUser.id).catch(() => null);
            if (!member) {
                return interaction.reply({ content: 'Couldn’t find that member in this server!', ephemeral: true });
            }
            const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
            const highestThreshold = ROLE_TIER_DATA.filter(t => count >= t.vouches).pop();

            if (highestThreshold) {
                for (const oldRoleId of currentRoles) {
                    if (oldRoleId !== highestThreshold.roleId && member.roles.cache.has(oldRoleId)) {
                        await member.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                const roleToAdd = interaction.guild.roles.cache.get(highestThreshold.roleId);
                if (!roleToAdd) {
                    return interaction.reply({ content: `Role with ID ${highestThreshold.roleId} not found. Please update the bot's role configuration.`, ephemeral: true });
                }
                if (!member.roles.cache.has(highestThreshold.roleId)) {
                    await member.roles.add(highestThreshold.roleId).catch(error => {
                        logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`);
                        throw error;
                    });
                    await interaction.reply(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                } else {
                    await interaction.reply(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
                }
            } else {
                await interaction.reply(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
            }
        }

        if (interaction.commandName === 'vouches') {
            const mentionedUser = interaction.options.getUser('user') || interaction.user;
            const count = vouchCounts.get(mentionedUser.id) || 0;
            await interaction.reply(`${mentionedUser.tag} has ${count} vouch${count === 1 ? '' : 'es'}, based on explicit @mentions.`);
        }

        if (interaction.commandName === 'vouchsearch') {
            const member = interaction.member;
            if (!member || !member.roles.cache.has(OWNER_ROLE_ID)) {
                return interaction.reply({ content: 'Only the owner can use this command.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('user');
            const channelOption = interaction.options.getChannel('channel') || await findChannel(interaction.guild, null);
            await processMentionsInChannel(channelOption, interaction.guild, targetUser.id);
            const targetMember = interaction.guild.members.cache.get(targetUser.id);
            await interaction.reply(`Vouch counts and roles for ${targetMember.user.tag} have been updated based on explicit @mentions in ${channelOption.name}.`);
        }

        if (interaction.commandName === 'unvouch') {
            const member = interaction.member;
            if (!member || !member.roles.cache.has(MOD_ROLE_ID)) {
                return interaction.reply({ content: 'Only moderators can use this command.', ephemeral: true });
            }

            const mentionedUser = interaction.options.getUser('user');
            if (!mentionedUser) {
                return interaction.reply({ content: 'Please mention a user to remove a vouch from with an @mention!', ephemeral: true });
            }

            const currentCount = vouchCounts.get(mentionedUser.id) || 0;
            if (currentCount > 0) {
                vouchCounts.set(mentionedUser.id, currentCount - 1);
                saveVouchData(vouchCounts);

                const targetMember = interaction.guild.members.cache.get(mentionedUser.id);
                if (!targetMember) {
                    return interaction.reply({ content: 'Couldn’t find that member in this server!', ephemeral: true });
                }

                const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => targetMember.roles.cache.has(id));
                const highestThreshold = ROLE_TIER_DATA.filter(t => (currentCount - 1) >= t.vouches).pop();

                if (highestThreshold) {
                    for (const oldRoleId of currentRoles) {
                        if (oldRoleId !== highestThreshold.roleId && targetMember.roles.cache.has(oldRoleId)) {
                            await targetMember.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    const roleToAdd = interaction.guild.roles.cache.get(highestThreshold.roleId);
                    if (!roleToAdd) {
                        return interaction.reply({ content: `Role with ID ${highestThreshold.roleId} not found. Please update the bot's role configuration.`, ephemeral: true });
                    }
                    await targetMember.roles.add(highestThreshold.roleId);
                    await interaction.reply(`${mentionedUser.tag} now has ${currentCount - 1} vouch${(currentCount - 1) === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                } else {
                    for (const role of ROLE_TIER_DATA) {
                        if (targetMember.roles.cache.has(role.roleId)) {
                            await targetMember.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    await interaction.reply(`${mentionedUser.tag} now has ${currentCount - 1} vouch${(currentCount - 1) === 1 ? '' : 'es'}.`);
                }
            } else {
                await interaction.reply(`${mentionedUser.tag} has no vouches to remove.`);
            }
        }

        if (interaction.commandName === 'vouchreset') {
            const member = interaction.member;
            if (!member || !member.roles.cache.has(MOD_ROLE_ID)) {
                return interaction.reply({ content: 'Only moderators can use this command.', ephemeral: true });
            }

            vouchCounts.clear();
            saveVouchData(vouchCounts);

            const guild = interaction.guild;
            const members = guild.members.cache;
            for (const member of members.values()) {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
            await interaction.reply('All vouch counts and roles have been reset to 0.');
        }

        if (interaction.commandName === 'vouchwipe') {
            const member = interaction.member;
            if (!member || !member.roles.cache.has(OWNER_ROLE_ID)) {
                return interaction.reply({ content: 'Only the owner can use this command.', ephemeral: true });
            }

            vouchCounts.clear();
            saveVouchData(vouchCounts);

            const guild = interaction.guild;
            const members = guild.members.cache;
            for (const member of members.values()) {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
            await interaction.reply('All vouch counts and roles have been wiped.');
        }
    } catch (error) {
        logError(`Command ${interaction.commandName} failed: ${error.message}`);
        // Fix 4: Enhance error handling
        await interaction.reply({
            content: `An error occurred: ${error.message}. Please check the bot logs or contact an administrator.`,
            ephemeral: true
        }).catch(err => logError(`Failed to send error reply: ${err.message}`));
    }
});

client.on('error', error => logError(`Discord client error: ${error.message}`));

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login. Please check your DISCORD_TOKEN.');
    console.error('Error details:', error.message);
    if (!process.env.DISCORD_TOKEN) logError('DISCORD_TOKEN is missing in environment variables.');
});
