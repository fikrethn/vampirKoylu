const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms[code]);
    return code;
}

function getRoomBySocketId(socketId) {
    for (const code in rooms) {
        if (rooms[code].players.find(p => p.id === socketId)) {
            return rooms[code];
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log(`Yeni kullanıcı: ${socket.id}`);

    // --- LOBİ İŞLEMLERİ ---
    socket.on('createRoom', (data, callback) => {
        const { playerName, password } = data;
        if (!playerName || playerName.trim() === '') return callback({ success: false, message: 'Oyuncu adı boş!' });

        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            password: password || null,
            hostId: socket.id,
            status: 'lobby',
            settings: { vampireCount: 1 },
            players: [ { id: socket.id, name: playerName, isHost: true, isAlive: true } ],
            votes: {}
        };

        socket.join(roomCode);
        callback({ success: true, roomCode, isHost: true, players: rooms[roomCode].players });
    });

    socket.on('joinRoom', (data, callback) => {
        const { playerName, roomCode, password } = data;
        if (!playerName || playerName.trim() === '') return callback({ success: false, message: 'Oyuncu adı boş!' });
        
        const upperCode = roomCode.toUpperCase();
        const room = rooms[upperCode];

        if (!room) return callback({ success: false, message: 'Oda bulunamadı!' });
        if (room.status !== 'lobby') return callback({ success: false, message: 'Oyun çoktan başlamış!' });
        if (room.password && room.password !== password) return callback({ success: false, message: 'Hatalı şifre!' });

        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true });
        socket.join(upperCode);
        
        io.to(upperCode).emit('roomUpdated', { players: room.players, settings: room.settings });
        callback({ success: true, roomCode: upperCode, isHost: false, players: room.players, settings: room.settings });
    });

    // --- OYUN İŞLEMLERİ ---
    socket.on('startGame', (data) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.hostId !== socket.id) return;
        
        if (room.players.length < 3) {
            return socket.emit('notification', 'Oyun için en az 3 oyuncu gerekir!');
        }

        room.settings.vampireCount = data.vampireCount || 1;
        
        let vCount = Math.min(room.settings.vampireCount, Math.floor(room.players.length / 2));
        if(vCount < 1) vCount = 1;

        let roles = Array(vCount).fill('vampir').concat(Array(room.players.length - vCount).fill('koylu'));
        // Shuffle roles
        roles.sort(() => Math.random() - 0.5);

        room.players.forEach((p, index) => {
            p.role = roles[index];
            p.isAlive = true;
        });

        room.status = 'playing';
        io.to(room.id).emit('gameStarted');
        io.to(room.id).emit('roomUpdated', { players: room.players });
        
        room.players.forEach(p => io.to(p.id).emit('roleAssigned', p.role));
        startNightPhase(room);
    });

    function startNightPhase(room) {
        room.phase = 'night';
        room.votes = {};
        const alivePlayers = room.players.filter(p => p.isAlive);
        const nonVampireAlive = alivePlayers.filter(p => p.role !== 'vampir');
        
        room.players.forEach(p => {
            if (!p.isAlive) {
                io.to(p.id).emit('phaseChanged', { phase: 'night', message: 'Gece çöktü. Vampirler hedefini seçiyor...' });
                return;
            }

            let options = [];
            if (p.role === 'vampir') {
                 options = nonVampireAlive.map(ap => ({ id: ap.id, name: ap.name }));
            }
            
            io.to(p.id).emit('phaseChanged', {
                phase: 'night',
                message: 'Gece çöktü. Vampirler hedefini seçiyor...',
                alivePlayers: options
            });
        });
    }

    socket.on('vampireAction', (targetId) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.phase !== 'night') return;
        
        const me = room.players.find(p => p.id === socket.id);
        if (!me || me.role !== 'vampir' || !me.isAlive) return;

        room.votes[socket.id] = targetId;
        const aliveVampires = room.players.filter(p => p.isAlive && p.role === 'vampir');
        
        if (Object.keys(room.votes).length === aliveVampires.length) {
            processNightVotes(room);
        }
    });

    function processNightVotes(room) {
        let voteCounts = {};
        Object.values(room.votes).forEach(tId => { voteCounts[tId] = (voteCounts[tId] || 0) + 1; });
        
        let victimId = null;
        let max = 0;
        for (const [tId, count] of Object.entries(voteCounts)) {
            if (count > max) { max = count; victimId = tId; }
        }

        let msg = `Sabah oldu. Gece sakin geçti. Kimse ölmedi.`;
        if (victimId) {
            const victim = room.players.find(p => p.id === victimId);
            if (victim) {
                victim.isAlive = false;
                io.to(victim.id).emit('youDied');
                msg = `Sabah oldu. ${victim.name} gece vampirler tarafından öldürüldü!`;
            }
        }

        io.to(room.id).emit('roomUpdated', { players: room.players });
        io.to(room.id).emit('phaseChanged', { phase: 'day', message: msg });

        if (!checkWin(room)) {
            setTimeout(() => startVotingPhase(room), 5000);
        }
    }

    function startVotingPhase(room) {
        room.phase = 'voting';
        room.votes = {};
        const alivePlayers = room.players.filter(p => p.isAlive);
        
        room.players.forEach(p => {
            if (!p.isAlive) {
                io.to(p.id).emit('phaseChanged', { phase: 'voting', message: 'Köy Meclisi Toplandı! Kimi asmak istersiniz?' });
                return;
            }

            const options = alivePlayers.filter(ap => ap.id !== p.id).map(ap => ({ id: ap.id, name: ap.name }));
            
            io.to(p.id).emit('phaseChanged', {
                phase: 'voting',
                message: 'Köy Meclisi Toplandı! Kimi asmak istersiniz/şüpheleniyorsunuz? (Chat/Sözlü tartışma yapın, ardından oy verin)',
                alivePlayers: options
            });
        });
    }

    socket.on('dayVote', (targetId) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.phase !== 'voting') return;
        
        const me = room.players.find(p => p.id === socket.id);
        if (!me || !me.isAlive) return;

        room.votes[socket.id] = targetId;
        const alivePlayers = room.players.filter(p => p.isAlive);
        
        if (Object.keys(room.votes).length === alivePlayers.length) {
            processDayVotes(room);
        }
    });

    function processDayVotes(room) {
        let voteCounts = {};
        Object.values(room.votes).forEach(tId => { voteCounts[tId] = (voteCounts[tId] || 0) + 1; });
        
        let executedId = null;
        let max = 0;
        for (const [tId, count] of Object.entries(voteCounts)) {
            if (count > max) { max = count; executedId = tId; }
        }

        if (executedId) {
            const executed = room.players.find(p => p.id === executedId);
            if (executed) {
                executed.isAlive = false;
                io.to(executed.id).emit('youDied');
                io.to(room.id).emit('phaseChanged', {
                    phase: 'night',
                    message: `Oylama Sonucu: ${executed.name} asıldı! Rolü: ${executed.role === 'vampir' ? 'VAMPİR' : 'KÖYLÜ'}`
                });
            }
        } else {
             io.to(room.id).emit('phaseChanged', {
                phase: 'night',
                message: 'Oylama Sonucu: Kimse yeterli oy almadı, kimse asılmadı.'
            });
        }

        io.to(room.id).emit('roomUpdated', { players: room.players });

        if (!checkWin(room)) {
            setTimeout(() => startNightPhase(room), 5000);
        }
    }

    function checkWin(room) {
        const alive = room.players.filter(p => p.isAlive);
        const vCount = alive.filter(p => p.role === 'vampir').length;
        const kCount = alive.length - vCount;

        if (vCount === 0) {
            io.to(room.id).emit('gameOver', { winner: 'KÖYLÜLER', message: 'Tüm vampirler yok edildi, köy huzura kavuştu.' });
            setTimeout(() => resetRoom(room), 6000);
            return true;
        } else if (vCount >= kCount) {
            io.to(room.id).emit('gameOver', { winner: 'VAMPİRLER', message: 'Vampirler köyün çoğunluğunu ele geçirdi. Artık burası onların çöplüğü!' });
            setTimeout(() => resetRoom(room), 6000);
            return true;
        }
        return false;
    }

    function resetRoom(room) {
        room.status = 'lobby';
        room.players.forEach(p => { p.isAlive = true; p.role = null; });
        io.to(room.id).emit('returnToLobby', { players: room.players, settings: room.settings });
    }

    // --- ÇIKIŞ KONTROLÜ ---
    socket.on('disconnect', () => leaveRoom(socket.id));
    socket.on('leaveRoom', () => {
        leaveRoom(socket.id);
        socket.emit('leftRoom');
    });

    function leaveRoom(socketId) {
        for (const code in rooms) {
            const room = rooms[code];
            const pIndex = room.players.findIndex(p => p.id === socketId);
            
            if (pIndex !== -1) {
                const wasHost = room.players[pIndex].isHost;
                const pName = room.players[pIndex].name;
                
                room.players.splice(pIndex, 1);
                if (room.players.length === 0) {
                    delete rooms[code];
                } else {
                    if (wasHost && room.players.length > 0) {
                        room.players[0].isHost = true;
                        room.hostId = room.players[0].id;
                        io.to(room.hostId).emit('hostChanged', true);
                    }
                    io.to(code).emit('roomUpdated', { players: room.players, settings: room.settings });
                    io.to(code).emit('notification', `${pName} ayrıldı.`);
                    
                    if (room.status === 'playing') checkWin(room);
                }
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) targetSocket.leave(code);
                break;
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`));
