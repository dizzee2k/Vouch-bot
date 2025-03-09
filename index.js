require('web-streams-polyfill');
require('dotenv').config();
const { Client, IntentsBitField } = require('discord.js');
const fs = require('fs');

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

const PREFIX = '/';
const DEFAULT_VOUCH_CHANNEL_NAME = 'vouch';
const VOUCH_CHANNEL_ID = '1306602749621698560';
const ROLE_TIER_DATA = [
    { roleId: '1339056153170284576', vouches: 3 }, // 🚀🥳Trainer 🥳 🚀
    { roleId: '1339056251090243654', vouches: 15 }, // ⚡️Seasoned Gym Leader ⚡️
    { roleId: '1339056315904954471', vouches: 30 }  // 🔥PxC “Elite 4” 🔥
];

const MOD_ROLE_ID = '1306596690903437323'; // Mod role ID
const OWNER_ROLE_ID = '1306596817588191274'; // Owner role ID

function loadVouchData() {
    try {
        const data = fs.readFileSync('vouchData.json', 'utf8');
        return new Map(JSON.parse(data));
    } catch (error) {
        console.log('No vouch data found, starting fresh:', error.message);
        return new Map();
    }
}

function saveVouchData(vouchCounts) {
    try {
        fs.writeFileSync('vouchData.json', JSON.stringify([...vouchCounts]));
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
        channel = guild.channels.cache.find(c => c.name.toLowerCase() === cleanChannelName && c.type === 'GUILD_TEXT');
        if (channel) {
            console.log(`Found channel by name: ${channel.name} (ID: ${channel.id})`);
            return channel;
        }
    }

    channel = guild.channels.cache.find(c => c.name.toLowerCase() === DEFAULT_VOUCH_CHANNEL_NAME && c.type === 'GUILD_TEXT');
    if (channel) {
        console.log(`Falling back to default vouch channel: ${channel.name} (ID: ${channel.id})`);
        return channel;
    }

    const textChannels = guild.channels.cache.filter(c => c.type === 'GUILD_TEXT');
    console.log('Available text channels in guild:', textChannels.map(c => `${c.name} (ID: ${c.id})`).join(', '));
    throw new Error(`Could not find channel '${channelMentionOrName || DEFAULT_VOUCH_CHANNEL_NAME}'. Ensure the channel exists, is text-based, and the bot has access.`);
}

async function processMentionsInChannel(channel, guild, targetUserId = null) {
    try {
        if (!channel || !channel.isTextBased()) {
            throw new Error(`Channel is not defined or not text-based. Ensure ${channel?.id || 'unknown'} is a text channel.`);
        }

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

        let messages = await channel.messages.fetch({ limit: 100 });
        let lastId = messages.last()?.id;
        let totalMessages = messages.size;

        while (lastId && totalMessages < 500) {
            const newMessages = await channel.messages.fetch({ limit: 100, before: lastId });
            if (newMessages.size === 0) break;
            messages = messages.concat(newMessages);
            totalMessages += newMessages.size;
            lastId = newMessages.last()?.id;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`Fetched ${totalMessages} messages in channel ${channel.id}`);
        await channel.send(`Fetched ${totalMessages} messages in channel ${channel.name} for vouch search.`);

        let mentionCount = 0;

        messages.forEach(message => {
            if (message.author.bot || message.content.startsWith(PREFIX)) return;

            message.mentions.users.forEach(user => {
                if (memberIds.has(user.id)) {
                    if (!targetUserId || user.id === targetUserId) {
                        const currentCount = vouchCounts.get(user.id) || 0;
                        if (currentCount < 50) {
                            vouchCounts.set(user.id, currentCount + 1);
                            mentionCount++;
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
            const member = guild.members.cache.get(targetUserId);
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
                const member = guild.members.cache.get(userId);
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
        await channel?.send(`There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the channel name/ID is correct.`);
    }
}

client.once('ready', async () => {
    console.log('Vouch Bot is online!');
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Invite Link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=268435456&scope=bot`);
    try {
        const guild = client.guilds.cache.first();
        if (guild) {
            const channel = await findChannel(guild, DEFAULT_VOUCH_CHANNEL_NAME);
            await channel.send('Vouch Bot is online and ready to track vouches based on explicit @mentions!');
            console.log(`Startup message sent to channel ${channel.id} (Name: ${channel.name})`);
            await processMentionsInChannel(channel, guild);
        } else {
            logError('No guild found. Ensure the bot is in a server.');
        }
    } catch (error) {
        logError(`Failed to send startup message: ${error.message}`);
        console.log(`Error sending startup message: ${error.message}`);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.channel.id === VOUCH_CHANNEL_ID && !message.content.startsWith(PREFIX)) {
        const uniqueMentions = new Set();
        for (const [userId, user] of message.mentions.users) {
            console.log(`Checking mention of ${user.tag} in message by ${message.author.tag}`);
            if (!uniqueMentions.has(userId)) {
                uniqueMentions.add(userId);
                console.log(`Found explicit @mention of ${user.tag} in message by ${message.author.tag}`);

                const currentCount = vouchCounts.get(userId) || 0;
                vouchCounts.set(userId, currentCount + 1);
                saveVouchData(vouchCounts);

                try {
                    const member = message.guild.members.cache.get(userId);
                    if (member) {
                        const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => member.roles.cache.has(id));
                        const count = vouchCounts.get(userId);
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
                                await message.channel.send(`${user.tag} now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                            } else {
                                await message.channel.send(`${user.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
                            }
                        }
                    }
                } catch (error) {
                    logError(`Failed to update roles for ${user.tag} from mention: ${error.message}`);
                    await message.channel.send('There was an issue updating roles. Check bot permissions.');
                }
            }
        }
        return;
    }

    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    let command = args.shift()?.toLowerCase();

    if (command === 'vouch' && args[0]?.toLowerCase() === 'search') {
        const member = message.member;
        if (!member || !member.roles.cache.has(OWNER_ROLE_ID)) {
            return message.reply('Only the owner can use this command.');
        }

        try {
            const guild = message.guild;
            if (!guild) throw new Error('Guild not found. Ensure the bot is in the correct server.');

            console.log(`Received /vouchsearch command with args: ${args.join(', ')}`);

            let channelMention = null;
            let userMention = null;

            // Look for channel mention or name
            const channelMatch = args.find(arg => arg.startsWith('<#') && arg.endsWith('>'));
            if (channelMatch) channelMention = channelMatch;
            else {
                const channelName = args.find(arg => arg.startsWith('#'));
                if (channelName) channelMention = channelName.replace(/^#/, '');
            }

            // Look for user mention (e.g., @dizzeee2k or <@USER_ID>)
            userMention = args.find(arg => arg.startsWith('<@') && (arg.endsWith('>') || arg.endsWith('>!')));
            if (!userMention) {
                // Try to find a username or nickname mention (e.g., @dizzeee2k)
                const usernameMention = args.find(arg => arg.startsWith('@') && !arg.startsWith('<@'));
                if (usernameMention) {
                    const username = usernameMention.replace(/^@/, '').toLowerCase();
                    const member = guild.members.cache.find(m => 
                        m.user.username.toLowerCase() === username || 
                        m.nickname?.toLowerCase() === username
                    );
                    if (member) userMention = `<@${member.user.id}>`;
                }
            }

            if (!userMention) {
                throw new Error('No user mentioned. Please mention a user with @mention.');
            }

            let channel;
            if (channelMention) channel = await findChannel(guild, channelMention);
            else channel = await findChannel(guild, DEFAULT_VOUCH_CHANNEL_NAME);

            const userIdMatch = userMention.match(/<@!?(\d+)>/);
            if (!userIdMatch) {
                throw new Error(`Invalid user mention format: ${userMention}`);
            }

            const targetUserId = userIdMatch[1];
            const targetUser = await client.users.fetch(targetUserId).catch(error => {
                throw new Error(`User ${userMention} not found: ${error.message}`);
            });
            if (!guild.members.cache.has(targetUserId)) {
                throw new Error(`User ${userMention} is not a member of this server.`);
            }

            await processMentionsInChannel(channel, guild, targetUserId);
            const targetMember = guild.members.cache.get(targetUserId);
            await message.channel.send(`Vouch counts and roles for ${targetMember.user.tag} have been updated based on explicit @mentions in ${channel.name}.`);
        } catch (error) {
            logError(`Failed to search vouches: ${error.message}`);
            await message.reply(`There was an issue searching for vouches: ${error.message}. Check bot permissions, channel access, or ensure the channel/user is correct.`);
        }
        return;
    }

    if (command === 'vouch') {
        const mentionedUser = message.mentions.users.first();
        if (!mentionedUser) return message.reply('Please mention a user to vouch for with an @mention!');
        if (mentionedUser.id === message.author.id) return message.reply('You can’t vouch for yourself!');

        const count = (vouchCounts.get(mentionedUser.id) || 0) + 1;
        vouchCounts.set(mentionedUser.id, count);
        saveVouchData(vouchCounts);

        try {
            const member = message.guild.members.cache.get(mentionedUser.id);
            if (!member) return message.reply('Couldn’t find that member in this server!');
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
                    await message.channel.send(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                } else {
                    await message.channel.send(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
                }
            } else {
                await message.channel.send(`${mentionedUser.tag} now has ${count} vouch${count === 1 ? '' : 'es'}.`);
            }
        } catch (error) {
            logError(`Failed to update roles for ${mentionedUser.tag}: ${error.message}`);
            await message.channel.send('There was an issue updating roles. Check bot permissions.');
        }
    }

    if (command === 'vouches') {
        const mentionedUser = message.mentions.users.first() || message.author;
        const count = vouchCounts.get(mentionedUser.id) || 0;
        try {
            await message.reply(`${mentionedUser.tag} has ${count} vouch${count === 1 ? '' : 'es'}, based on explicit @mentions.`);
        } catch (error) {
            logError(`Failed to reply to vouches command for ${mentionedUser.tag}: ${error.message}`);
        }
    }

    if (command === 'unvouch') {
        const member = message.member;
        if (!member || !member.roles.cache.has(MOD_ROLE_ID)) return message.reply('Only moderators can use this command.');

        const mentionedUser = message.mentions.users.first();
        if (!mentionedUser) return message.reply('Please mention a user to remove a vouch from with an @mention!');

        const currentCount = vouchCounts.get(mentionedUser.id) || 0;
        if (currentCount > 0) {
            vouchCounts.set(mentionedUser.id, currentCount - 1);
            saveVouchData(vouchCounts);

            try {
                const targetMember = message.guild.members.cache.get(mentionedUser.id);
                if (!targetMember) return message.reply('Couldn’t find that member in this server!');

                const currentRoles = ROLE_TIER_DATA.map(t => t.roleId).filter(id => targetMember.roles.cache.has(id));
                const highestThreshold = ROLE_TIER_DATA.filter(t => (currentCount - 1) >= t.vouches).pop();

                if (highestThreshold) {
                    for (const oldRoleId of currentRoles) {
                        if (oldRoleId !== highestThreshold.roleId && targetMember.roles.cache.has(oldRoleId)) {
                            await targetMember.roles.remove(oldRoleId).catch(error => logError(`Failed to remove role ${oldRoleId}: ${error.message}`));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    await targetMember.roles.add(highestThreshold.roleId).catch(error => logError(`Failed to add role ${highestThreshold.roleId}: ${error.message}`));
                    await message.channel.send(`${mentionedUser.tag} now has ${currentCount - 1} vouch${(currentCount - 1) === 1 ? '' : 'es'} and earned the <@&${highestThreshold.roleId}> role!`);
                } else {
                    for (const role of ROLE_TIER_DATA) {
                        if (targetMember.roles.cache.has(role.roleId)) {
                            await targetMember.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                    await message.channel.send(`${mentionedUser.tag} now has ${currentCount - 1} vouch${(currentCount - 1) === 1 ? '' : 'es'}.`);
                }
            } catch (error) {
                logError(`Failed to update roles for ${mentionedUser.tag} during unvouch: ${error.message}`);
                await message.channel.send('There was an issue updating roles. Check bot permissions.');
            }
        } else {
            await message.reply(`${mentionedUser.tag} has no vouches to remove.`);
        }
    }

    if (command === 'vouchreset') {
        const member = message.member;
        if (!member || !member.roles.cache.has(MOD_ROLE_ID)) return message.reply('Only moderators can use this command.');

        vouchCounts.clear();
        saveVouchData(vouchCounts);

        try {
            const guild = message.guild;
            if (!guild) throw new Error('Guild not found. Ensure the bot is in the correct server.');
            const members = guild.members.cache;
            for (const member of members.values()) {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
            await message.channel.send('All vouch counts and roles have been reset to 0.');
        } catch (error) {
            logError(`Failed to reset vouches and roles: ${error.message}`);
            await message.channel.send('There was an issue resetting vouches and roles. Check bot permissions.');
        }
    }

    if (command === 'vouchwipe') {
        const member = message.member;
        if (!member || !member.roles.cache.has(OWNER_ROLE_ID)) return message.reply('Only the owner can use this command.');

        vouchCounts.clear();
        saveVouchData(vouchCounts);

        try {
            const guild = message.guild;
            if (!guild) throw new Error('Guild not found. Ensure the bot is in the correct server.');
            const members = guild.members.cache;
            for (const member of members.values()) {
                for (const role of ROLE_TIER_DATA) {
                    if (member.roles.cache.has(role.roleId)) {
                        await member.roles.remove(role.roleId).catch(error => logError(`Failed to remove role ${role.roleId}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
            await message.channel.send('All vouch counts and roles have been wiped.');
        } catch (error) {
            logError(`Failed to wipe vouches and roles: ${error.message}`);
            await message.channel.send('There was an issue wiping vouches and roles. Check bot permissions.');
        }
    }
});

client.on('error', error => logError(`Discord client error: ${error.message}`));

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Failed to login. Please check your DISCORD_TOKEN.');
    console.error('Error details:', error.message);
    if (!process.env.DISCORD_TOKEN) logError('DISCORD_TOKEN is missing in environment variables.');
});