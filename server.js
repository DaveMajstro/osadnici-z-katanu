const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let rooms = {};
const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f8fafc'];

function initGame(game) {
    const resources = ['WOOD','WOOD','WOOD','WOOD','BRICK','BRICK','BRICK','SHEEP','SHEEP','SHEEP','SHEEP','WHEAT','WHEAT','WHEAT','WHEAT','ORE','ORE','ORE', 'DESERT'].sort(() => Math.random() - 0.5);
    const numbers = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12].sort(() => Math.random() - 0.5);
    let numIdx = 0;

    game.map = resources.map((type, i) => ({
        id: i, type: type, number: type === 'DESERT' ? null : numbers[numIdx++]
    }));

    game.robberHexId = game.map.find(h => h.type === 'DESERT').id;
    game.devDeck = [...Array(10).fill('KNIGHT'), ...Array(5).fill('POINT'), ...Array(5).fill('PROGRESS')].sort(() => Math.random() - 0.5);

    game.largestArmyHolder = null;
    game.largestArmySize = 2;
    game.winner = null;
    game.restartVotes = []; 
    game.waitingForRobber = false;
    game.playedCardThisTurn = false;
    game.hasRolled = false;

    game.players.forEach((p, i) => {
        p.resources = { WOOD: 0, BRICK: 0, SHEEP: 0, WHEAT: 0, ORE: 0 };
        p.devCards = { KNIGHT: 0, POINT: 0, PROGRESS: 0 };
        p.knightsPlayed = 0;
        p.color = PLAYER_COLORS[i];
        p.score = 0;
        p.discardNeeded = 0;
    });

    game.phase = 'SETUP_1'; game.subPhase = 'SETTLEMENT'; game.setupTurn = 0; game.turn = 0;
    game.settlements = {}; game.roads = {}; game.lastDice = [1, 1]; game.logs = ["Hra začala!"];
}

function addLog(game, msg) { game.logs.unshift(msg); if (game.logs.length > 6) game.logs.pop(); }

function checkWinner(game) {
    const winnerPlayer = game.players.find(p => p.score >= 10);
    if (winnerPlayer) game.winner = winnerPlayer.name;
}

function updateInstruction(game) {
    const player = game.players[game.turn];
    if (!player) return;
    const isDiscarding = game.players.some(p => p.discardNeeded > 0);
    if (isDiscarding) { game.instruction = `ČEKÁ SE NA ODEVZDÁNÍ KARET...`; } 
    else if (game.waitingForRobber) { game.instruction = `${player.name.toUpperCase()}: PŘEMÍSTI ZLODĚJE`; } 
    else if (game.phase.startsWith('SETUP')) { game.instruction = `${player.name.toUpperCase()}: POSTAV ${game.subPhase === 'SETTLEMENT' ? 'VESNICI' : 'CESTU'}`; } 
    else {
        if (!game.hasRolled) game.instruction = `${player.name.toUpperCase()}: HOĎ KOSTKOU!`;
        else game.instruction = `${player.name.toUpperCase()}: TVŮJ TAH`;
    }
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId); socket.roomId = roomId;
        if (!rooms[roomId]) rooms[roomId] = { players: [] };
        const game = rooms[roomId];
        if (game.players.length < 4 && !game.players.find(p => p.id === socket.id)) {
            game.players.push({ id: socket.id, name: playerName || `Hráč ${game.players.length + 1}`, score: 0 });
            if (game.players.length >= 2 && !game.map) initGame(game);
        }
        updateInstruction(game); io.in(roomId).emit('gameState', game);
    });

    // FUNKCE: PŘI ODPOJENÍ SMAZAT CELOU MÍSTNOST
    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            delete rooms[socket.roomId];
            io.in(socket.roomId).emit('roomDestroyed');
        }
    });

    socket.on('dev_addKnight', (roomId) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (player) { player.devCards.KNIGHT++; io.in(roomId).emit('gameState', game); }
    });

    socket.on('dev_addResources', (roomId) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (player) {
            player.resources.WOOD += 5; player.resources.BRICK += 5;
            player.resources.SHEEP += 5; player.resources.WHEAT += 5;
            player.resources.ORE += 5;
            io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('rollDice', (roomId) => {
        const game = rooms[roomId];
        if (!game || game.winner || game.phase !== 'PLAYING' || game.players[game.turn].id !== socket.id || game.hasRolled) return;
        game.lastDice = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
        game.hasRolled = true;
        const sum = game.lastDice[0] + game.lastDice[1];
        if (sum === 7) {
            let anyoneDiscards = false;
            game.players.forEach(p => {
                const total = Object.values(p.resources).reduce((a, b) => a + b, 0);
                if (total > 7) { p.discardNeeded = Math.floor(total / 2); anyoneDiscards = true; }
            });
            if (!anyoneDiscards) game.waitingForRobber = true;
        } else {
            game.map.forEach(hex => {
                if (hex.number === sum && hex.id !== game.robberHexId) {
                    Object.values(game.settlements).forEach(s => {
                        if (s.hexIds.includes(hex.id)) {
                            const owner = game.players.find(p => p.id === s.playerId);
                            if (owner) owner.resources[hex.type] += (s.type === 'city' ? 2 : 1);
                        }
                    });
                }
            });
        }
        updateInstruction(game); io.in(roomId).emit('gameState', game);
    });

    socket.on('buyDevCard', (roomId) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (!game || game.winner || !player || game.players[game.turn].id !== socket.id || !game.hasRolled) return;
        if (player.resources.ORE >= 1 && player.resources.WHEAT >= 1 && player.resources.SHEEP >= 1 && game.devDeck.length > 0) {
            player.resources.ORE--; player.resources.WHEAT--; player.resources.SHEEP--;
            const card = game.devDeck.pop();
            player.devCards[card]++;
            if (card === 'POINT') { player.score++; checkWinner(game); }
            socket.emit('cardBoughtInfo', card);
            addLog(game, `${player.name} koupil kartu.`);
            io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('playDevCard', ({ roomId, type }) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (!game || game.winner || !player || game.players[game.turn].id !== socket.id || player.devCards[type] <= 0 || game.playedCardThisTurn) return;

        player.devCards[type]--;
        game.playedCardThisTurn = true;
        if (type === 'KNIGHT') {
            player.knightsPlayed++;
            game.waitingForRobber = true;
            addLog(game, `⚔️ ${player.name} zahrál rytíře.`);
            if (player.knightsPlayed > game.largestArmySize) {
                if (game.largestArmyHolder !== player.id) {
                    if (game.largestArmyHolder) {
                        const oldHolder = game.players.find(p => p.id === game.largestArmyHolder);
                        if (oldHolder) oldHolder.score -= 2;
                    }
                    game.largestArmyHolder = player.id;
                    player.score += 2;
                    addLog(game, `🎖️ ${player.name} získal Největší armádu!`);
                }
                game.largestArmySize = player.knightsPlayed;
            }
        } else if (type === 'PROGRESS') {
            const r = ['WOOD', 'BRICK', 'SHEEP', 'WHEAT', 'ORE'];
            player.resources[r[Math.floor(Math.random()*5)]]++;
            player.resources[r[Math.floor(Math.random()*5)]]++;
        }
        checkWinner(game);
        io.in(roomId).emit('visualCardPlay', { player: player.name, type: type });
        updateInstruction(game); io.in(roomId).emit('gameState', game);
    });

    socket.on('voteRestart', (roomId) => {
        const game = rooms[roomId];
        if (!game || !game.winner) return;
        if (!game.restartVotes.includes(socket.id)) game.restartVotes.push(socket.id);
        if (game.restartVotes.length === game.players.length) {
            initGame(game);
            updateInstruction(game);
        }
        io.in(roomId).emit('gameState', game);
    });

    socket.on('moveRobber', ({ roomId, hexId }) => {
        const game = rooms[roomId];
        if (game && !game.winner && game.waitingForRobber && game.players[game.turn].id === socket.id) {
            game.robberHexId = hexId; game.waitingForRobber = false;
            updateInstruction(game); io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('discardResource', ({ roomId, resType }) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (player && player.discardNeeded > 0 && player.resources[resType] > 0) {
            player.resources[resType]--; player.discardNeeded--;
            if (game.players.every(p => p.discardNeeded === 0)) game.waitingForRobber = true;
            updateInstruction(game); io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('bankTrade', ({ roomId, give, get }) => {
        const game = rooms[roomId];
        const player = game?.players.find(p => p.id === socket.id);
        if (game && !game.winner && player && game.players[game.turn].id === socket.id && player.resources[give] >= 4) {
            player.resources[give] -= 4; player.resources[get] += 1;
            addLog(game, `⚖️ ${player.name} měnil s bankou.`);
            io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('buildSettlement', ({ roomId, vertexId, hexIds, neighbors }) => {
        const game = rooms[roomId]; const player = game?.players[game.turn];
        if (!game || game.winner || player.id !== socket.id || game.settlements[vertexId]?.type === 'city') return;
        if (game.settlements[vertexId]) {
            if (game.phase === 'PLAYING' && player.resources.ORE >= 3 && player.resources.WHEAT >= 2) {
                player.resources.ORE -= 3; player.resources.WHEAT -= 2;
                game.settlements[vertexId].type = 'city'; player.score++;
                checkWinner(game); io.in(roomId).emit('gameState', game);
            }
            return;
        }
        if (neighbors.some(n => game.settlements[n])) return;
        if (game.phase === 'PLAYING' && !Object.values(game.roads).some(r => r.playerId === player.id && (r.v1 === vertexId || r.v2 === vertexId))) return;
        const isSetup = game.phase.startsWith('SETUP');
        if (isSetup || (player.resources.WOOD >= 1 && player.resources.BRICK >= 1 && player.resources.SHEEP >= 1 && player.resources.WHEAT >= 1)) {
            if (!isSetup) { player.resources.WOOD--; player.resources.BRICK--; player.resources.SHEEP--; player.resources.WHEAT--; }
            else if (game.phase === 'SETUP_2') hexIds.forEach(id => { const h = game.map.find(x => x.id === id); if(h && h.type !== 'DESERT') player.resources[h.type]++; });
            game.settlements[vertexId] = { playerId: player.id, color: player.color, hexIds, type: 'settlement' };
            player.score++; checkWinner(game);
            game.lastBuiltVertex = vertexId; game.subPhase = 'ROAD';
            updateInstruction(game); io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('buildRoad', ({ roomId, edgeId, v1, v2 }) => {
        const game = rooms[roomId]; const player = game?.players[game.turn];
        if (!game || game.winner || player.id !== socket.id || game.roads[edgeId]) return;
        const isSetup = game.phase.startsWith('SETUP');
        if (isSetup) { if (v1 !== game.lastBuiltVertex && v2 !== game.lastBuiltVertex) return; }
        else { if (!((game.settlements[v1]?.playerId === player.id) || (game.settlements[v2]?.playerId === player.id) || Object.values(game.roads).some(r => r.playerId === player.id && (r.v1 === v1 || r.v1 === v2 || r.v2 === v1 || r.v2 === v2)))) return; }
        if (isSetup || (player.resources.WOOD >= 1 && player.resources.BRICK >= 1)) {
            if (!isSetup) { player.resources.WOOD--; player.resources.BRICK--; }
            game.roads[edgeId] = { playerId: player.id, color: player.color, v1, v2 };
            if (isSetup) {
                if (game.phase === 'SETUP_1') { if (game.setupTurn < game.players.length - 1) game.setupTurn++; else game.phase = 'SETUP_2'; }
                else { if (game.setupTurn > 0) game.setupTurn--; else game.phase = 'PLAYING'; }
                game.turn = game.setupTurn; game.subPhase = 'SETTLEMENT';
            }
            updateInstruction(game); io.in(roomId).emit('gameState', game);
        }
    });

    socket.on('passTurn', (roomId) => {
        const game = rooms[roomId];
        if (game && !game.winner && game.hasRolled && game.players[game.turn].id === socket.id && !game.waitingForRobber && !game.players.some(p => p.discardNeeded > 0)) {
            game.turn = (game.turn + 1) % game.players.length; game.hasRolled = false; 
            game.subPhase = 'SETTLEMENT'; game.playedCardThisTurn = false;
            updateInstruction(game); io.in(roomId).emit('gameState', game);
        }
    });
});

server.listen(3000);