import React, { useState, useEffect, useRef } from 'react';
import './App.css';

// --- Xirsys Constants (NOW LOADED FROM ENVIRONMENT VARIABLES) ---
// The actual values will be provided by Railway securely.
const XIRSYS_SECRET_ID = process.env.REACT_APP_XIRSYS_SECRET_ID;
const XIRSYS_SECRET_TOKEN = process.env.REACT_APP_XIRSYS_SECRET_TOKEN;
const XIRSYS_BASE_URL = process.env.REACT_APP_XIRSYS_BASE_URL;
// --- END Xirsys Constants ---

function App() {
  // --- WebSocket & App State ---
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [username, setUsername] = useState('');
  const [currentStatus, setCurrentStatus] = useState('disconnected');
  const [partnerUsername, setPartnerUsername] = useState(null);
  const [realtimeStats, setRealtimeStats] = useState({
    connectedUsers: 0,
    waitingUsers: 0,
    activeConversations: 0,
  });

  const ws = useRef(null);

  // --- WebRTC State ---
  const localAudioRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localStream = useRef(null); // Will hold the MediaStream object
  const peerConnection = useRef(null);

  // --- Utility: Add message to logs ---
  const addMessageToLogs = (from, text) => {
    setMessages(prev => {
      // Keep only the last 100 messages to prevent performance issues
      const newMessages = [...prev, { from, text }];
      return newMessages.slice(Math.max(newMessages.length - 100, 0));
    });
  };

  // --- Utility: Clean up WebRTC resources ---
  const cleanupWebRTC = () => {
    if (peerConnection.current) {
        addMessageToLogs('WebRTC Cleanup', 'Closing existing RTCPeerConnection.');
        peerConnection.current.close();
        peerConnection.current = null;
    }
    if (localAudioRef.current) {
        localAudioRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
        addMessageToLogs('WebRTC Cleanup', 'Remote audio stream cleared.');
    }
  };

  // --- WebSocket Connection & Message Handling ---
  useEffect(() => {
    // IMPORTANT: This URL is now read from a secure environment variable on Railway.
    //const backendWsUrl = process.env.REACT_APP_BACKEND_WS_URL || "ws://localhost:8080";
	const PORT = process.env.PORT || 8080;
	const wss = new WebSocket.Server({ port: PORT });
	const backendWsUrl = "wss://vocaline-production.up.railway.app";

    if (!backendWsUrl) {
      console.error('REACT_APP_BACKEND_WS_URL is not set!');
      addMessageToLogs('Error', 'Backend URL missing. Check Railway config.');
      return; // Prevent WebSocket connection if URL is not set
    }

    ws.current = new WebSocket(backendWsUrl);
    
    ws.current.onopen = () => {
      console.log('WebSocket Connected!');
      setIsConnected(true);
      setCurrentStatus('connected');
      addMessageToLogs('System', 'Connected to Vocaline server.');
      if (!localStream.current) { 
        requestMicrophoneAccess();
      }
    };

    ws.current.onmessage = (event) => {
      let messageData;
      try {
        messageData = JSON.parse(event.data);
      } catch (e) {
        console.error('Failed to parse incoming message as JSON:', event.data);
        addMessageToLogs('Error', `Failed to parse incoming message: ${event.data}`);
        return;
      }
      
      console.log('Message from server:', messageData);
      addMessageToLogs('Server RX', JSON.stringify(messageData)); 

      switch (messageData.type) {
        case 'welcome':
          addMessageToLogs('System', messageData.payload.message);
          break;
        case 'status_update':
          setCurrentStatus(messageData.payload.status);
          addMessageToLogs('System', `Status updated: ${messageData.payload.status}`);
          if (messageData.payload.status === 'waiting_for_match' || messageData.payload.status === 'disconnected') {
            setPartnerUsername(null);
            cleanupWebRTC(); 
          }
          break;
        case 'stats_update':
          console.log('Frontend: Receiving stats_update:', messageData.payload);
          setRealtimeStats(messageData.payload);
          console.log('Frontend: realtimeStats state updated to:', messageData.payload); 
          break; 
        case 'match_found':
          setPartnerUsername(messageData.payload.partnerUsername);
          setCurrentStatus('in-call');
          addMessageToLogs('System', `Match found with ${messageData.payload.partnerUsername}!`);
          cleanupWebRTC(); 
          initiatePeerConnection(); 
          if (messageData.payload.initiateCall) { 
              createOffer(); 
          }
          break;
        case 'partner_disconnected':
          setPartnerUsername(null);
          setCurrentStatus('waiting_for_match'); 
          addMessageToLogs('System', `Your partner (${messageData.payload.message.split(' has ')[0]}) has disconnected. Searching for new partner...`);
          cleanupWebRTC(); 
          break;
        case 'error':
          addMessageToLogs('Error', messageData.payload.message);
          break;
        case 'info':
          addMessageToLogs('Info', messageData.payload.message);
          break;
        case 'offer':
          addMessageToLogs('WebRTC RX', `Offer from ${messageData.payload.from}`);
          handleOffer(messageData.payload.sdp);
          break;
        case 'answer':
          addMessageToLogs('WebRTC RX', 'Answer received.');
          handleAnswer(messageData.payload.sdp);
          break;
        case 'candidate':
          addMessageToLogs('WebRTC RX', 'ICE Candidate received.');
          handleCandidate(messageData.payload.candidate);
          break;
        case 'partner_mute_status': 
          addMessageToLogs('Partner Status', `${messageData.payload.username} is now ${messageData.payload.isMuted ? 'muted' : 'unmuted'}.`);
          break;
        default:
          addMessageToLogs('Server', event.data); 
          break;
      }
    };

    ws.current.onclose = () => {
      console.log('WebSocket Disconnected!');
      setIsConnected(false);
      setCurrentStatus('disconnected');
      addMessageToLogs('System', 'Disconnected from server.');
      setPartnerUsername(null);
      cleanupWebRTC(); 
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
        addMessageToLogs('WebRTC Cleanup', 'Local stream tracks stopped due to WS close.');
      }
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket Error:', error);
      addMessageToLogs('Error', 'WebSocket connection error.');
    };

    return () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.close();
      }
      cleanupWebRTC(); 
      if (localStream.current) { 
        localStream.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []); 

  // --- WebRTC Functions ---

  // Function to request microphone access
  const requestMicrophoneAccess = async () => {
    try {
      if (localStream.current) { 
          addMessageToLogs('System', 'Microphone stream already active.');
          return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = stream;
      }
      addMessageToLogs('System', 'Microphone access granted and stream acquired!');
    } catch (error) {
      console.error('Error accessing microphone:', error);
      addMessageToLogs('Error', 'Failed to access microphone. Please allow access.');
      alert('Vocaline requires microphone access for voice calls. Please grant permission.');
    }
  };

  // Function to initiate RTCPeerConnection
  const initiatePeerConnection = async () => {
      if (peerConnection.current) {
          addMessageToLogs('WebRTC', 'Closing existing PeerConnection before initiating new one (from initiatePeerConnection).');
          peerConnection.current.close();
          peerConnection.current = null;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null; 
      }

      let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // Default Google STUN server

      // --- Fetch Xirsys ICE servers from environment variables ---
      if (XIRSYS_SECRET_ID && XIRSYS_SECRET_TOKEN && XIRSYS_BASE_URL) {
          try {
              const XIRSYS_AUTH_TOKEN = btoa(`${XIRSYS_SECRET_ID}:${XIRSYS_SECRET_TOKEN}`);
              const response = await fetch(`https://${XIRSYS_BASE_URL}/_turn/${XIRSYS_SECRET_ID}`, {
                  method: 'PUT',
                  headers: {
                      'Authorization': `Basic ${XIRSYS_AUTH_TOKEN}`,
                      'Content-Type': 'application/json',
                      'Content-Length': 0 
                  }
              });

              if (response.ok) {
                  const xirsysData = await response.json();
                  if (xirsysData.e === 'ok' && xirsysData.v && xirsysData.v.iceServers) {
                      iceServers = xirsysData.v.iceServers;
                      addMessageToLogs('Xirsys', 'Successfully fetched Xirsys ICE servers.');
                      console.log('Xirsys ICE Servers:', iceServers);
                  } else {
                      console.error('Xirsys API error:', xirsysData);
                      addMessageToLogs('Xirsys Error', `Failed to fetch Xirsys ICE servers: ${xirsysData.e || 'Unknown error'}. Falling back to default STUN.`);
                  }
              } else {
                  console.error('Failed to fetch Xirsys ICE servers, HTTP status:', response.status);
                  addMessageToLogs('Xirsys Error', `Failed to fetch Xirsys ICE servers (HTTP ${response.status}). Falling back to default STUN.`);
              }
          } catch (error) {
              console.error('Error fetching Xirsys ICE servers:', error);
              addMessageToLogs('Xirsys Error', `Exception fetching Xirsys ICE servers: ${error.message}. Falling back to default STUN.`);
          }
      } else {
          addMessageToLogs('Xirsys Warning', 'Xirsys credentials not provided. Using default STUN server.');
          console.warn('Xirsys credentials (REACT_APP_XIRSYS_SECRET_ID, REACT_APP_XIRSYS_SECRET_TOKEN, REACT_APP_XIRSYS_BASE_URL) are not set. Using default STUN server.');
      }
      // --- End Fetch Xirsys ICE servers ---

      const configuration = { iceServers: iceServers };

      peerConnection.current = new RTCPeerConnection(configuration);
      addMessageToLogs('WebRTC', 'New RTCPeerConnection initiated with configured ICE servers.');

      if (localStream.current) {
          localStream.current.getTracks().forEach(track => {
              peerConnection.current.addTrack(track, localStream.current); 
          });
          addMessageToLogs('WebRTC', 'Local audio track added to PeerConnection.');
      } else {
          console.warn('Local stream not available when initiating peer connection. Requesting it now.');
          addMessageToLogs('Error', 'Local microphone not available for call. Attempting to re-acquire.');
          requestMicrophoneAccess(); 
          return; // Exit if stream not immediately available
      }

      peerConnection.current.ontrack = (event) => {
          if (remoteAudioRef.current && event.streams && event.streams[0]) {
              remoteAudioRef.current.srcObject = event.streams[0];
              remoteAudioRef.current.play().catch(e => console.error("Error playing remote audio:", e));
              addMessageToLogs('WebRTC', 'Remote audio stream received and playing!');
          }
      };

      peerConnection.current.onicecandidate = (event) => {
          if (event.candidate) {
              if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                  ws.current.send(JSON.stringify({
                      type: 'candidate',
                      payload: { candidate: event.candidate }
                  }));
                  addMessageToLogs('WebRTC TX', 'Sent ICE candidate.');
              }
          }
      };

      peerConnection.current.oniceconnectionstatechange = () => {
          console.log(`ICE connection state changed: ${peerConnection.current.iceConnectionState}`);
          addMessageToLogs('WebRTC', `ICE state: ${peerConnection.current.iceConnectionState}`);
          if (peerConnection.current.iceConnectionstate === 'failed' || peerConnection.current.iceConnectionState === 'disconnected') {
              addMessageToLogs('WebRTC Error', 'WebRTC connection failed or disconnected. Prompting change partner.');
          }
      };
      
      peerConnection.current.onnegotiationneeded = async () => {
          console.log("onnegotiationneeded fired. This is fine if we're creating an offer, otherwise it might indicate re-negotiation needs.");
      };
  };

  const createOffer = async () => {
    if (!peerConnection.current) {
        console.error('PeerConnection not initialized to create offer. This should not happen.');
        addMessageToLogs('Error', 'WebRTC: Cannot create offer, PC not ready.');
        return;
    }
    try {
        const offer = await peerConnection.current.createOffer();
        await peerConnection.current.setLocalDescription(offer);
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
                type: 'offer',
                payload: { sdp: peerConnection.current.localDescription }
            }));
            addMessageToLogs('WebRTC TX', 'Sent SDP Offer.');
        }
    } catch (e) {
        console.error('Error creating or setting offer:', e);
        addMessageToLogs('Error', 'WebRTC: Error creating offer.');
    }
  };

  const handleOffer = async (sdp) => {
      if (!peerConnection.current) {
          addMessageToLogs('WebRTC Warning', 'PeerConnection not initialized for incoming offer. Initializing...');
          initiatePeerConnection();
      }
      try {
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(sdp));
          addMessageToLogs('WebRTC', 'Received SDP Offer, setting remote description.');

          const answer = await peerConnection.current.createAnswer();
          await peerConnection.current.setLocalDescription(answer);
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
              ws.current.send(JSON.stringify({
                  type: 'answer',
                  payload: { sdp: peerConnection.current.localDescription }
              }));
              addMessageToLogs('WebRTC TX', 'Created and sent SDP Answer.');
          }
      } catch (e) {
          console.error('Error handling offer:', e);
          addMessageToLogs('Error', 'WebRTC: Error handling offer.');
      }
  };

  const handleAnswer = async (sdp) => {
      if (!peerConnection.current) {
          console.error('PeerConnection not initialized when handling answer.');
          addMessageToLogs('Error', 'WebRTC: PC not ready for answer.');
          return;
      }
      try {
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(sdp));
          addMessageToLogs('WebRTC', 'Received SDP Answer, setting remote description.');
      } catch (e) {
          console.error('Error handling answer:', e);
          addMessageToLogs('Error', 'WebRTC: Error handling answer.');
      }
  };

  const handleCandidate = async (candidate) => {
      if (!peerConnection.current) {
          console.error('PeerConnection not initialized when handling candidate.');
          addMessageToLogs('WebRTC Warning', 'PC not ready for candidate, will queue if possible or drop.');
          return;
      }
      try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
          addMessageToLogs('WebRTC', 'Added ICE candidate.');
      }
      catch (e) {
          console.error('Error adding ICE candidate:', e);
          addMessageToLogs('Error', `WebRTC: Error adding ICE candidate: ${e.message}.`);
      }
  };

  const handleJoinMatchmaking = async () => {
    if (!localStream.current) {
        addMessageToLogs('Error', 'Microphone access required to join matchmaking.');
        alert('Please allow microphone access to join Vocaline.');
        await requestMicrophoneAccess();
        if (!localStream.current) {
            addMessageToLogs('Error', 'Microphone access still not granted. Cannot join.');
            return;
        }
    }

    if (ws.current && ws.current.readyState === WebSocket.OPEN && username.trim() !== '') {
      ws.current.send(JSON.stringify({ type: 'join', payload: { username: username.trim() } }));
      addMessageToLogs('You TX', `Joining as ${username.trim()}...`);
    } else if (username.trim() === '') {
      alert('Please enter a username to join matchmaking.');
    } else {
      addMessageToLogs('System', 'Not connected to server yet.');
    }
  };

  const handleChangePartner = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      addMessageToLogs('You TX', 'Requesting new partner...');
      ws.current.send(JSON.stringify({ type: 'change_partner' }));
      
      setCurrentStatus('waiting_for_match');
      setPartnerUsername(null);
      cleanupWebRTC();
    }
  };

  const handleDisconnect = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      addMessageToLogs('You TX', 'Disconnecting from Vocaline...');
      ws.current.send(JSON.stringify({ type: 'disconnect_from_matchmaking' }));
      
      cleanupWebRTC();
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => track.stop());
        localStream.current = null;
        addMessageToLogs('WebRTC Cleanup', 'Local stream tracks stopped on full disconnect.');
      }
    }
  };

  const handleMuteToggle = () => {
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        addMessageToLogs('You', `Microphone ${audioTrack.enabled ? 'unmuted' : 'muted'}.`);
        if (ws.current && ws.current.readyState === WebSocket.OPEN && currentStatus === 'in-call') {
            ws.current.send(JSON.stringify({ type: 'mute', payload: { isMuted: !audioTrack.enabled } }));
            addMessageToLogs('You TX', `Sent mute status: ${!audioTrack.enabled}`);
        }
      } else {
          addMessageToLogs('Error', 'No audio track found to mute/unmute.');
      }
    } else {
        addMessageToLogs('Error', 'No local stream active for mute/unmute.');
    }
  };

  // --- Debugging for disabled button state ---
  const isJoinButtonDisabled = !isConnected || currentStatus === 'waiting_for_match' || currentStatus === 'in-call' || username.trim() === '' || !localStream.current;
  useEffect(() => {
    console.log('--- Button Disabled State Check ---');
    console.log('!isConnected:', !isConnected);
    console.log('currentStatus === "waiting_for_match":', currentStatus === 'waiting_for_match');
    console.log('currentStatus === "in-call":', currentStatus === 'in-call');
    console.log('username.trim() === "":', username.trim() === '');
    console.log('!localStream.current:', !localStream.current);
    console.log('-----------------------------------');
  }, [isConnected, currentStatus, username, localStream.current]);


  return (
    <div className="App">
      <header className="App-header">
        <h1>Vocaline 🎤</h1>
        <p className="tagline">Connectez-vous par la voix avec d'autres chauffeurs routiers</p>
      </header>

      <section className="realtime-stats-section">
        <h2>Statistiques en temps réel</h2>
        <div className="stats-grid">
          <div className="stat-item">
            <span className="stat-label">Utilisateurs connectés:</span>
            <span className="stat-value">{realtimeStats.connectedUsers}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">En attente:</span>
            <span className="stat-value">{realtimeStats.waitingUsers}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Conversations actives:</span>
            <span className="stat-value">{realtimeStats.activeConversations}</span>
          </div>
        </div>
      </section>

      <section className="join-vocaline-section">
        <h2>Rejoindre Vocaline</h2>
        <div className="input-group">
          <label htmlFor="username">Votre nom d'utilisateur:</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Ex: TruckerMike"
            disabled={isConnected && (currentStatus === 'waiting_for_match' || currentStatus === 'in-call')}
          />
        </div>
        <button
          onClick={handleJoinMatchmaking}
          disabled={isJoinButtonDisabled}
        >
          Rejoindre le matchmaking
        </button>
      </section>

      <section className="voice-conversation-section">
        <h2>Conversation vocale</h2>
        <p className="connection-status">
          Statut de connexion: <strong>{currentStatus === 'in-call' ? `Connecté avec ${partnerUsername}` : currentStatus.replace(/_/g, ' ')}</strong>
        </p>
        {currentStatus === 'in-call' && (
          <p className="active-call-indicator">
            📞 Appel vocal actif avec {partnerUsername}
          </p>
        )}
        <div className="conversation-controls">
          <audio ref={localAudioRef} autoPlay muted style={{ display: 'none' }}></audio>
          <audio ref={remoteAudioRef} autoPlay style={{ display: 'none' }}></audio>

          <button onClick={handleMuteToggle} disabled={currentStatus !== 'in-call' || !localStream.current}>
            Couper le micro
          </button>
          <button onClick={handleChangePartner} disabled={currentStatus !== 'in-call' && currentStatus !== 'waiting_for_match'}>
            Changer de partenaire
          </button>
          <button onClick={handleDisconnect} disabled={!isConnected || currentStatus === 'disconnected'}>
            Se déconnecter
          </button>
        </div>
      </section>

      <section className="messages-section">
        <h2>Logs Frontend</h2>
        <div className="messages-log">
          {messages.map((msg, index) => (
            <p key={index}><strong data-log-type={msg.from}>[{msg.from}]:</strong> {msg.text}</p>
          ))}
        </div>
      </section>

      <section className="feedback-section">
        <h2>Votre avis nous intéresse</h2>
        <textarea
          placeholder="Écrivez votre avis ici..."
          rows="4"
          maxLength="500"
        ></textarea>
        <p className="char-count">0/500</p>
        <button disabled>Envoyer mon avis (À implémenter)</button>
      </section>
    </div>
  );
}

export default App;