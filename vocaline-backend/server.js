const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server started on port ${PORT}`);

// --- Global State Management ---
// connectedUsers Map stores WebSocket -> { id, username, status, partnerWs, lastPartnerWs }
// 'partnerWs' is current partner. 'lastPartnerWs' is the *immediate previous* partner to avoid rematching.
const connectedUsers = new Map();
const matchmakingQueue = []; // Array of WebSocket clients in the 'waiting' status

// --- Helper Function: Generate Unique ID ---
function generateUniqueId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// --- Helper Function: Send Message to a Client ---
function sendMessage(ws, type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            const messageString = JSON.stringify({ type, payload });
            ws.send(messageString);
            console.log(`[SERVER_SEND_SUCCESS]: Type "${type}" to client ID: ${connectedUsers.get(ws)?.id || 'unknown'} | Size: ${messageString.length} bytes`);
        } catch (error) {
            console.error(`[SERVER_SEND_ERROR]: Failed to send message type "${type}" to client ID: ${connectedUsers.get(ws)?.id || 'unknown'}. Error: ${error.message}`);
        }
    } else {
        console.warn(`[SERVER_SEND_WARN]: Attempted to send type "${type}" to closed/null/invalid client WS object. ID: ${connectedUsers.get(ws)?.id || 'unknown'}. readyState: ${ws ? ws.readyState : 'N/A'}.`);
    }
}

// --- Helper Function: Update Real-time Stats to all connected users ---
function updateRealtimeStats() {
    let connected = connectedUsers.size;
    let waiting = matchmakingQueue.length;
    let activeConversations = 0;

    connectedUsers.forEach(user => {
        if (user.status === 'in-call') {
            activeConversations++;
        }
    });
    activeConversations /= 2; // Each conversation involves two participants

    const stats = {
        connectedUsers: connected,
        waitingUsers: waiting,
        activeConversations: activeConversations
    };

    console.log(`[SERVER_STATS_CALC]: Calculated stats - Connected: ${connected}, Waiting: ${waiting}, Active Conversations: ${activeConversations}`);

    if (connectedUsers.size === 0) {
        console.warn("[SERVER_STATS_SEND_CHECK]: No connected clients in 'connectedUsers' Map. Cannot send stats.");
        return; // Exit if no clients to send to
    }

    connectedUsers.forEach((userData, userWs) => { 
        if (userWs && userWs.readyState === WebSocket.OPEN) {
            try {
                const messageString = JSON.stringify({ type: 'stats_update', payload: stats });
                userWs.send(messageString); 
                console.log(`[SERVER_STATS_SENT_CONFIRM]: Sent stats_update to ${userData.username || 'Guest'} (ID: ${userData.id}) | Stats: ${JSON.stringify(stats)} | Bytes: ${messageString.length}`);
            } catch (error) {
                console.error(`[SERVER_STATS_SEND_ERROR_INNER]: Failed to send stats_update to ${userData.username || 'Guest'} (ID: ${userData.id}). Error: ${error.message}`);
            }
        } else {
            console.warn(`[SERVER_STATS_SENT_SKIP_INVALID]: Skipped sending stats_update to client ${userData?.username || 'unknown'} (ID: ${userData?.id || 'unknown'}) - Invalid WS or not OPEN (readyState: ${userWs?.readyState || 'unknown'}).`);
        }
    });
    
    console.log(`[FINAL_STATS_UPDATE_LOG]: Stats update process completed.`);
}

// --- Matchmaking Logic ---
function attemptMatch(userWs) {
    const requestingUserData = connectedUsers.get(userWs);
    if (!requestingUserData || requestingUserData.status !== 'waiting') {
        console.log(`[MATCH_ATTEMPT_SKIP]: User ${requestingUserData?.username || 'unknown'} (ID: ${requestingUserData?.id || 'unknown'}) not in waiting state or not found.`);
        return false;
    }

    const lastPartnerWs = requestingUserData.lastPartnerWs; // Get the specific last partner for this requesting user
    
    // Filter out the requesting user, users not waiting, AND the requesting user's LAST partner
    const eligiblePartners = matchmakingQueue.filter(
        partnerWs => partnerWs !== userWs && // Not self
                     connectedUsers.get(partnerWs)?.status === 'waiting' && // Is waiting
                     partnerWs !== lastPartnerWs // IMPORTANT: Exclude the last partner of the *requesting user*
    );

    if (eligiblePartners.length > 0) {
        const randomIndex = Math.floor(Math.random() * eligiblePartners.length);
        const partnerWs = eligiblePartners[randomIndex];
        const partnerData = connectedUsers.get(partnerWs);

        if (requestingUserData.status === 'waiting' && partnerData?.status === 'waiting') {
            // Remove both users from the matchmaking queue
            let index = matchmakingQueue.indexOf(userWs);
            if (index !== -1) {
                matchmakingQueue.splice(index, 1);
                console.log(`[MATCH_QUEUE]: Removed ${requestingUserData.username} from queue. New size: ${matchmakingQueue.length}`);
            }
            index = matchmakingQueue.indexOf(partnerWs);
            if (index !== -1) {
                matchmakingQueue.splice(index, 1);
                console.log(`[MATCH_QUEUE]: Removed ${partnerData.username} from queue. New size: ${matchmakingQueue.length}`);
            }

            requestingUserData.status = 'in-call';
            requestingUserData.partner = partnerWs;
            requestingUserData.lastPartnerWs = null; // Reset last partner once matched to allow new matches
            
            partnerData.status = 'in-call';
            partnerData.partner = userWs;
            partnerData.lastPartnerWs = null; // Reset last partner for the new partner too

            console.log(`[MATCH_SUCCESS]: Match found: ${requestingUserData.username} (ID: ${requestingUserData.id}) <-> ${partnerData.username} (ID: ${partnerData.id})`);

            sendMessage(userWs, 'match_found', { partnerUsername: partnerData.username, initiateCall: true }); 
            sendMessage(partnerWs, 'match_found', { partnerUsername: requestingUserData.username, initiateCall: false }); 

            updateRealtimeStats();
            return true; 
        } else {
            console.warn(`[MATCH_FAILED_STATUS]: One or both users changed status unexpectedly during match attempt. Requesting: ${requestingUserData.status}, Partner: ${partnerData?.status}`);
        }
    } else {
        console.log(`[MATCH_NO_PARTNER]: No eligible partners found for ${requestingUserData.username} (ID: ${requestingUserData.id}). Queue size: ${matchmakingQueue.length}. Last partner excluded: ${lastPartnerWs ? connectedUsers.get(lastPartnerWs)?.username : 'None'}`);
    }
    return false;
}

// --- Connection Handling ---
wss.on('connection', ws => {
    const connectionId = generateUniqueId();
    console.log(`[CLIENT_CONNECT]: Client connected with connection ID: ${connectionId}`);
    
    // Initialize user data, including lastPartnerWs
    connectedUsers.set(ws, { id: connectionId, username: 'Guest', status: 'connected', partner: null, lastPartnerWs: null });
    
    sendMessage(ws, 'welcome', { message: 'Welcome to Vocaline. Please provide your username to join matchmaking.' });

    updateRealtimeStats(); 

    ws.on('message', message => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log(`[CLIENT_MSG_RX]: Client ID ${connectedUsers.get(ws)?.id || 'unknown'} received message type: ${parsedMessage.type}`);
        } catch (e) {
            console.error(`[CLIENT_MSG_ERROR]: Client ID ${connectedUsers.get(ws)?.id || 'unknown'} failed to parse message: ${message.toString()}. Error: ${e.message}`);
            return;
        }

        const user = connectedUsers.get(ws);
        if (!user) {
            console.warn(`[CLIENT_WARN]: Message from unknown client connection ID: ${connectionId}. Type: ${parsedMessage.type}`);
            return;
        }

        switch (parsedMessage.type) {
            case 'join':
                if (!parsedMessage.payload || !parsedMessage.payload.username) {
                    sendMessage(ws, 'error', { message: 'Username is required to join.' });
                    console.warn(`[JOIN_ERROR]: Client ID ${user.id} tried to join without username.`);
                    return;
                }
                
                if (user.status === 'waiting' || user.status === 'in-call') {
                    sendMessage(ws, 'info', { message: 'You are already in matchmaking or a call.' });
                    console.log(`[JOIN_INFO]: Client ID ${user.id} already in matchmaking/call.`);
                    return;
                }

                user.username = parsedMessage.payload.username;
                user.status = 'waiting';
                user.lastPartnerWs = null; // Clear last partner when joining fresh, as they are not coming from a call yet
                matchmakingQueue.push(ws);
                console.log(`[USER_JOINED_QUEUE]: ${user.username} (ID: ${user.id}) joined matchmaking. Queue size: ${matchmakingQueue.length}`);
                sendMessage(ws, 'status_update', { status: 'waiting_for_match' });
                
                setTimeout(() => {
                    if (user.status === 'waiting') { 
                        console.log(`[MATCH_TIMER]: Attempting match for ${user.username} (ID: ${user.id}) after delay.`);
                        attemptMatch(ws);
                    } else {
                        console.log(`[MATCH_TIMER_SKIP]: ${user.username} (ID: ${user.id}) no longer waiting after delay.`);
                    }
                }, 1000);

                updateRealtimeStats();
                break;

            case 'change_partner':
                console.log(`[CHANGE_PARTNER_REQ]: ${user.username} (ID: ${user.id}) wants to change partner.`);
                
                // If user was in a call, notify old partner and set their status to waiting
                if (user.status === 'in-call' && user.partner) {
                    const oldPartnerWs = user.partner;
                    const oldPartnerData = connectedUsers.get(oldPartnerWs);

                    if (oldPartnerData) {
                        sendMessage(oldPartnerWs, 'partner_disconnected', { message: `${user.username} has changed partners.` });
                        oldPartnerData.status = 'waiting';
                        oldPartnerData.partner = null;
                        // Set the current user as the last partner for the old partner
                        oldPartnerData.lastPartnerWs = ws; 
                        if (!matchmakingQueue.includes(oldPartnerWs)) {
                           matchmakingQueue.push(oldPartnerWs); 
                           console.log(`[PARTNER_REQUEUE]: ${oldPartnerData.username} re-added to queue after partner change.`);
                           sendMessage(oldPartnerWs, 'status_update', { status: 'waiting_for_match' });
                        } else {
                            console.log(`[PARTNER_IN_QUEUE_ALREADY]: ${oldPartnerData.username} was already in queue.`);
                        }
                    }
                }
                
                // Handle the user who initiated 'change_partner'
                user.status = 'waiting';
                user.partner = null;
                // Store their old partner so they don't get re-matched with them immediately
                // This is the critical line for preventing re-matching with the same partner
                // user.lastPartnerWs is implicitly set here as user.partner holds the old partner WS reference
                
                const userIndexInQueue = matchmakingQueue.indexOf(ws);
                if (userIndexInQueue !== -1) {
                    matchmakingQueue.splice(userIndexInQueue, 1);
                }
                matchmakingQueue.unshift(ws); // Add current user to the FRONT of the queue to prioritize them
                console.log(`[CHANGE_PARTNER_PRIO]: ${user.username} (ID: ${user.id}) moved to front of queue. New queue size: ${matchmakingQueue.length}`);

                sendMessage(ws, 'status_update', { status: 'waiting_for_match' });
                
                setTimeout(() => {
                    if (user.status === 'waiting') {
                        console.log(`[MATCH_TIMER]: Attempting prioritized match for ${user.username} (ID: ${user.id}) after change partner delay. Last partner to avoid: ${user.lastPartnerWs ? connectedUsers.get(user.lastPartnerWs)?.username : 'None'}`);
                        attemptMatch(ws);
                    } else {
                        console.log(`[MATCH_TIMER_SKIP]: ${user.username} (ID: ${user.id}) no longer waiting after change partner delay.`);
                    }
                }, 1000);

                updateRealtimeStats();
                break;

            case 'disconnect_from_matchmaking':
                console.log(`[DISCONNECT_REQ]: ${user.username} (ID: ${user.id}) is disconnecting from matchmaking.`);
                
                if (user.status === 'in-call' && user.partner) {
                    const oldPartnerWs = user.partner;
                    const oldPartnerData = connectedUsers.get(oldPartnerWs);

                    if (oldPartnerData) {
                        sendMessage(oldPartnerWs, 'partner_disconnected', { message: `${user.username} has left the conversation.` });
                        oldPartnerData.status = 'waiting';
                        oldPartnerData.partner = null;
                        oldPartnerData.lastPartnerWs = ws; // Set current user (the one disconnecting) as old partner for the remaining user
                        if (!matchmakingQueue.includes(oldPartnerWs)) {
                           matchmakingQueue.push(oldPartnerWs); 
                           console.log(`[PARTNER_REQUEUE]: ${oldPartnerData.username} re-added to queue after partner disconnect.`);
                           sendMessage(oldPartnerWs, 'status_update', { status: 'waiting_for_match' });
                           setTimeout(() => {
                               if (oldPartnerData.status === 'waiting') {
                                   attemptMatch(oldPartnerWs);
                               } else {
                                   console.log(`[MATCH_TIMER_SKIP]: ${oldPartnerData.username} no longer waiting after disconnect delay.`);
                               }
                           }, 1000);
                        } else {
                             console.log(`[PARTNER_IN_QUEUE_ALREADY]: ${oldPartnerData.username} was already in queue.`);
                        }
                    }
                }
                user.status = 'disconnected';
                user.partner = null;
                user.lastPartnerWs = null; // Clear last partner on full disconnect
                const indexInQueue = matchmakingQueue.indexOf(ws);
                if (indexInQueue !== -1) {
                    matchmakingQueue.splice(indexInQueue, 1);
                    console.log(`[QUEUE_REMOVE]: Removed ${user.username} from queue. New size: ${matchmakingQueue.length}`);
                }
                sendMessage(ws, 'status_update', { status: 'disconnected' });
                console.log(`[USER_DISCONNECTED]: ${user.username} fully disconnected from matchmaking system.`);
                updateRealtimeStats();
                break;
            
            // --- WebRTC Signaling Messages ---
            case 'offer':
            case 'answer':
            case 'candidate':
                if (user.status === 'in-call' && user.partner) {
                    if (user.partner.readyState === WebSocket.OPEN) {
                        sendMessage(user.partner, parsedMessage.type, { ...parsedMessage.payload, from: user.id });
                        console.log(`[WEBRTC_SIGNAL_FWD]: Forwarded ${parsedMessage.type} from ${user.username} (ID: ${user.id}) to partner ID: ${connectedUsers.get(user.partner)?.id || 'unknown'}`);
                    } else {
                        console.warn(`[WEBRTC_SIGNAL_WARN]: Partner of ${user.username} (ID: ${user.id}) is not OPEN (${user.partner.readyState}), cannot forward ${parsedMessage.type}.`);
                    }
                } else {
                    console.warn(`[WEBRTC_SIGNAL_WARN]: Received ${parsedMessage.type} from ${user.username} (ID: ${user.id}) but no active partner. Status: ${user.status}`);
                }
                break;

            case 'mute':
                if (user.status === 'in-call' && user.partner) {
                    if (user.partner.readyState === WebSocket.OPEN) {
                        sendMessage(user.partner, 'partner_mute_status', { username: user.username, isMuted: parsedMessage.payload.isMuted });
                        console.log(`[MUTE_STATUS_FWD]: Forwarded mute status from ${user.username} (ID: ${user.id}) to partner.`);
                    }
                }
                break;

            default:
                console.warn(`[UNKNOWN_MSG_TYPE]: Unknown message type received from ${user.username} (ID: ${user.id}): ${parsedMessage.type}`);
                sendMessage(ws, 'error', { message: 'Unknown message type.' });
                break;
        }
    });

    // Event listener for when the client closes the connection (browser tab closed, etc.)
    ws.on('close', () => {
        const user = connectedUsers.get(ws);
        if (user) {
            console.log(`[CLIENT_DISCONNECT]: ${user.username || 'Client'} (ID: ${user.id}) disconnected. Status: ${user.status}`);
            
            if (user.status === 'in-call' && user.partner) {
                const partnerWs = user.partner;
                const partnerData = connectedUsers.get(partnerWs);
                if (partnerData) {
                    sendMessage(partnerWs, 'partner_disconnected', { message: `${user.username} has left the conversation.` });
                    partnerData.status = 'waiting';
                    partnerData.partner = null;
                    partnerData.lastPartnerWs = ws; // Set current user (the one disconnecting) as old partner for the remaining user
                    if (!matchmakingQueue.includes(partnerWs)) {
                        matchmakingQueue.push(partnerWs);
                        console.log(`[PARTNER_REQUEUE_ON_DISCONNECT]: ${partnerData.username} re-added to queue.`);
                        sendMessage(partnerWs, 'status_update', { status: 'waiting_for_match' });
                        setTimeout(() => {
                            if (partnerData.status === 'waiting') {
                                attemptMatch(partnerWs);
                            } else {
                                console.log(`[MATCH_TIMER_SKIP]: ${partnerData.username} no longer waiting after disconnect re-queue delay.`);
                            }
                        }, 1000);
                    } else {
                        console.log(`[PARTNER_IN_QUEUE_ALREADY]: ${partnerData.username} was already in queue on disconnect.`);
                    }
                }
            }

            const indexInQueue = matchmakingQueue.indexOf(ws);
            if (indexInQueue !== -1) {
                matchmakingQueue.splice(indexInQueue, 1);
                console.log(`[QUEUE_REMOVE]: Removed ${user.username} from queue on disconnect. New size: ${matchmakingQueue.length}`);
            }

            connectedUsers.delete(ws);
            console.log(`[CONNECTED_USERS_DELETE]: Client ID ${user.id} removed from connectedUsers. New size: ${connectedUsers.size}`);
            updateRealtimeStats();
        } else {
            console.log('[CLIENT_DISCONNECT_UNKNOWN]: An unknown client disconnected.');
        }
    });

    ws.on('error', error => {
        console.error(`[WS_ERROR]: WebSocket error for client ID: ${connectedUsers.get(ws)?.id || 'unknown'}. Error: ${error.message}`);
    });
});