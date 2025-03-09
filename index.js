require('web-streams-polyfill');
require('dotenv').config();
const { Client, IntentsBitField, PermissionsBitField } = require('discord.js'); // Fix 1: Import PermissionsBitField
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

const PREFIX = '/';
const DEFAULT_VOUCH_CHANNEL_NAME = 'vouch';
const VOUCH_CHANNEL_ID = '1306602749621698560';
const ROLE_TIER_DATA = [
    { roleId: '1339056153170284576', vouches: 3 },
    { roleId: '1339056251090243654', vouches: 15 },
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

        // Fix 1: Update permission flags and Fix 2: Add logging
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
            console.log(`Bot lacks permissions in channel ${channel.id}: Missing ${missingPermNames.join(', ')}`); // Fix 2
            throw new Error(`Bot lacks the following permissions in channel ${channel.name}: ${missingPermNames.join(', ')}. Please grant these permissions to the bot.`);
        }
        console.log(`Bot has required permissions in channel ${channel.id}: ViewChannel, ReadMessageHistory, SendMessages`); // Fix 2

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
            if (message.author.bot || message.content.startsWith(PREFIX)) return;

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
                    if (!member.roles.cache.has(highestThreshold.roleId)) {
                        await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
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
                        if (!member.roles.cache.has(highestThreshold.roleId)) {
                            await member.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
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
        // Fix 4: Improve error messaging
        const errorMessage = error.message.includes('Bot lacks the following permissions')
            ? error.message
            : `There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the channel name/ID is correct.`;
        await channel?.send(errorMessage);
    }
}

client.once('ready', async () => {
    console.log('Vouch Bot is online!');
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Invite Link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=268435456&scope=bot`);
    try {
        const guild = client.guilds.cache.first();
        if (!guild) {
            throw new Error('No guild found. Ensure the bot is in a server.');
        }

        const channel = await findChannel(guild, DEFAULT_VOUCH_CHANNEL_NAME);
        await channel.send('Vouch Bot is online and ready to track vouches based on explicit @mentions!');

        // Fix 5: Ensure errors don't crash the bot
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

// Rest of the code (messageCreate, vouch, vouches, unvouch, etc.) remains unchanged

client.on('error', error => logError(`Discord client error: ${error.message}`));

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login. Please check your DISCORD_TOKEN.');
    console.error('Error details:', error.message);
    if (!process.env.DISCORD_TOKEN) logError('DISCORD_TOKEN is missing in environment variables.');
});
