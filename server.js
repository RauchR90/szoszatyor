const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// --- GLOBÁLIS HIBAELKAPÓK (Megakadályozzák, hogy a szerver leálljon Exited status 1-gyel) ---
process.on('uncaughtException', (err) => {
  console.error('VÁRATLAN HIBA ELKAPVA (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('NEM KEZELT PROMISE ELUTASÍTÁS (unhandledRejection):', reason);
});
// ------------------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

let WORD_DATABASE = [];
try {
  const wordsData = fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8');
  WORD_DATABASE = JSON.parse(wordsData);
} catch (err) {
  console.error('Hiba a words.json beolvasásakor:', err);
  WORD_DATABASE = [{ word: 'SZÓSZATYOR', category: 'fogalom' }];
}

const rooms = {};

function scrambleWord(word) {
  if (!word) return '';
  let scrambled = word.split('');
  for (let i = scrambled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [scrambled[i], scrambled[j]] = [scrambled[j], scrambled[i]];
  }
  if (scrambled.join('') === word && word.length > 1) {
    return scrambleWord(word);
  }
  return scrambled.join('');
}

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ username, room }) => {
    try {
      if (!username || !room) return;
      const cleanUsername = username.trim();
      const cleanRoom = room.trim();
      const lowerUsername = cleanUsername.toLowerCase();

      if (!rooms[cleanRoom]) {
        rooms[cleanRoom] = {
          players: {},
          currentWordObj: null,
          scrambledWord: '',
          gameActive: false,
          timer: null,
          autoTimer: null,
          isChampionship: false,
          championshipTarget: 0,
          wordsPlayedInChamp: 0,
          currentMusicIndex: 1
        };
      }

      const currentRoom = rooms[cleanRoom];
      
      let existingPlayerKey = Object.keys(currentRoom.players).find(
        key => currentRoom.players[key] && currentRoom.players[key].username && currentRoom.players[key].username.toLowerCase() === lowerUsername
      );

      if (existingPlayerKey && currentRoom.players[existingPlayerKey].isOnline) {
        socket.emit('errorMsg', 'Sajnos ezen a néven épp játszik a szobában valaki, kérlek, válassz másik nevet!');
        return;
      }

      const totalPlayersCount = Object.keys(currentRoom.players).length;
      if (!existingPlayerKey && totalPlayersCount >= 20) {
        socket.emit('errorMsg', 'Sajnos ez a szoba már fullon van, kérlek, válassz másik szobát!');
        return;
      }

      socket.join(cleanRoom);
      socket.username = cleanUsername;
      socket.roomName = cleanRoom;

      let isReconnect = false;
      let isSpectator = false;

      if (existingPlayerKey && !currentRoom.players[existingPlayerKey].isOnline) {
        isReconnect = true;
        const savedScore = currentRoom.players[existingPlayerKey].score;
        const savedSpectator = currentRoom.players[existingPlayerKey].isSpectator || false;
        
        if (currentRoom.players[existingPlayerKey].disconnectTimer) {
          clearTimeout(currentRoom.players[existingPlayerKey].disconnectTimer);
        }

        delete currentRoom.players[existingPlayerKey];

        currentRoom.players[socket.id] = {
          username: cleanUsername,
          score: savedScore,
          isOnline: true,
          isSpectator: savedSpectator,
          disconnectTimer: null
        };

        io.to(cleanRoom).emit('playerReconnected', { username: cleanUsername });

      } else {
        if (currentRoom.isChampionship) {
          isSpectator = true;
        }

        currentRoom.players[socket.id] = {
          username: cleanUsername,
          score: 0,
          isOnline: true,
          isSpectator: isSpectator,
          disconnectTimer: null
        };
      }

      socket.emit('joinedSuccessfully', { 
        room: cleanRoom, 
        username: cleanUsername,
        isReconnect: isReconnect,
        gameActive: currentRoom.gameActive,
        isChampionship: currentRoom.isChampionship,
        isSpectator: currentRoom.players[socket.id].isSpectator,
        activeRoundData: currentRoom.gameActive ? {
          scrambledWord: currentRoom.scrambledWord,
          category: currentRoom.currentWordObj ? currentRoom.currentWordObj.category : '',
          length: currentRoom.currentWordObj ? currentRoom.currentWordObj.word.length : 0,
          musicIndex: currentRoom.currentMusicIndex
        } : null
      });

      io.to(cleanRoom).emit('updatePlayerList', currentRoom.players);
    } catch (e) {
      console.error('Hiba a joinRoom eseménynél:', e);
    }
  });

  socket.on('leaveRoomIntentional', () => {
    try {
      const roomName = socket.roomName;
      if (roomName && rooms[roomName]) {
        const username = socket.username;
        
        if (rooms[roomName].players[socket.id] && rooms[roomName].players[socket.id].disconnectTimer) {
          clearTimeout(rooms[roomName].players[socket.id].disconnectTimer);
        }

        delete rooms[roomName].players[socket.id];

        socket.leave(roomName);
        socket.emit('leftSuccessfully');

        if (Object.keys(rooms[roomName].players).length === 0) {
          if (rooms[roomName].timer) clearInterval(rooms[roomName].timer);
          if (rooms[roomName].autoTimer) clearTimeout(rooms[roomName].autoTimer);
          delete rooms[roomName];
        } else {
          io.to(roomName).emit('updatePlayerList', rooms[roomName].players);
          io.to(roomName).emit('playerLeftIntentional', { username });
        }
      }
    } catch (e) {
      console.error('Hiba a leaveRoomIntentional eseménynél:', e);
    }
  });

  socket.on('sendChatMessage', (msg) => {
    try {
      if (socket.roomName && msg) {
        io.to(socket.roomName).emit('chatMessage', {
          sender: socket.username,
          text: msg
        });
      }
    } catch (e) {
      console.error('Hiba a sendChatMessage eseménynél:', e);
    }
  });

  socket.on('startGame', () => {
    try {
      const roomName = socket.roomName;
      const room = rooms[roomName];

      if (!room) return;
      if (room.gameActive || room.isChampionship) {
        socket.emit('errorMsg', 'A játék ebben a szobában már folyamatban van!');
        return;
      }

      startNewRound(roomName);
    } catch (e) {
      console.error('Hiba a startGame eseménynél:', e);
    }
  });

  socket.on('startChampionship', (targetPoints) => {
    try {
      const roomName = socket.roomName;
      const room = rooms[roomName];

      if (!room) return;
      if (room.gameActive || room.isChampionship) {
        socket.emit('errorMsg', 'Már folyamatban van egy feladvány vagy bajnokság!');
        return;
      }

      Object.keys(room.players).forEach(id => {
        if (room.players[id]) {
          room.players[id].score = 0;
          room.players[id].isSpectator = false;
        }
      });

      room.isChampionship = true;
      room.championshipTarget = targetPoints;
      room.wordsPlayedInChamp = 0;

      io.to(roomName).emit('updatePlayerList', room.players);
      io.to(roomName).emit('championshipStarted', { target: targetPoints });

      startNewRound(roomName);
    } catch (e) {
      console.error('Hiba a startChampionship eseménynél:', e);
    }
  });

  socket.on('submitGuess', (guess) => {
    try {
      const roomName = socket.roomName;
      const room = rooms[roomName];

      if (!room || !room.gameActive || !room.currentWordObj || !guess) return;

      if (room.players[socket.id] && room.players[socket.id].isSpectator) {
        socket.emit('errorMsg', 'Bajnokság alatt nézőként csatlakoztál, így nem tippelhetsz!');
        return;
      }

      const formattedGuess = guess.trim().toUpperCase();

      if (formattedGuess === room.currentWordObj.word) {
        if (room.timer) clearInterval(room.timer);
        room.gameActive = false;

        const earnedPoints = room.currentWordObj.word.length;
        if (room.players[socket.id]) {
          room.players[socket.id].score += earnedPoints;
        }
        const currentScore = room.players[socket.id] ? room.players[socket.id].score : 0;

        if (room.isChampionship && currentScore >= room.championshipTarget) {
          room.isChampionship = false;
          
          Object.keys(room.players).forEach(id => {
            if (room.players[id]) room.players[id].isSpectator = false;
          });

          io.to(roomName).emit('championshipWon', {
            winner: socket.username,
            word: room.currentWordObj.word,
            points: earnedPoints,
            players: room.players,
            target: room.championshipTarget
          });

        } else {
          io.to(roomName).emit('roundWon', {
            winner: socket.username,
            word: room.currentWordObj.word,
            points: earnedPoints,
            players: room.players,
            isChampionship: room.isChampionship
          });

          if (room.isChampionship) {
            scheduleNextRound(roomName, 12);
          }
        }

      } else {
        socket.emit('incorrectGuess');
      }
    } catch (e) {
      console.error('Hiba a submitGuess eseménynél:', e);
    }
  });

  socket.on('disconnect', () => {
    try {
      const roomName = socket.roomName;
      if (roomName && rooms[roomName] && rooms[roomName].players[socket.id]) {
        const username = socket.username;
        
        rooms[roomName].players[socket.id].isOnline = false;

        io.to(roomName).emit('updatePlayerList', rooms[roomName].players);
        io.to(roomName).emit('playerDisconnectedUnexpectedly', { username });

        // 5 PERCES TÜRELMI IDŐ BIZTONSÁGOS KEZELÉSE
        rooms[roomName].players[socket.id].disconnectTimer = setTimeout(() => {
          try {
            if (rooms[roomName] && rooms[roomName].players && rooms[roomName].players[socket.id]) {
              delete rooms[roomName].players[socket.id];
              
              if (Object.keys(rooms[roomName].players).length === 0) {
                if (rooms[roomName].timer) clearInterval(rooms[roomName].timer);
                if (rooms[roomName].autoTimer) clearTimeout(rooms[roomName].autoTimer);
                delete rooms[roomName];
              } else {
                io.to(roomName).emit('updatePlayerList', rooms[roomName].players);
                io.to(roomName).emit('playerRemovedAfterTimeout', { username });
              }
            }
          } catch (err) {
            console.error('Hiba a disconnect timeout-ban:', err);
          }
        }, 300000);
      }
    } catch (e) {
      console.error('Hiba a disconnect eseménynél:', e);
    }
  });
});

function startNewRound(roomName) {
  try {
    const room = rooms[roomName];
    if (!room) return;

    if (room.isChampionship) {
      room.wordsPlayedInChamp++;
      if (room.wordsPlayedInChamp > 200) {
        room.isChampionship = false;
        Object.keys(room.players).forEach(id => {
          if (room.players[id]) room.players[id].isSpectator = false;
        });

        io.to(roomName).emit('championshipEndedNoWinner');
        return;
      }
    }

    if (WORD_DATABASE.length === 0) return;

    const randomItem = WORD_DATABASE[Math.floor(Math.random() * WORD_DATABASE.length)];
    room.currentWordObj = randomItem;
    room.scrambledWord = scrambleWord(randomItem.word);
    room.gameActive = true;

    room.currentMusicIndex = Math.floor(Math.random() * 4) + 1;

    io.to(roomName).emit('newRound', {
      scrambledWord: room.scrambledWord,
      category: randomItem.category,
      length: randomItem.word.length,
      isChampionship: room.isChampionship,
      musicIndex: room.currentMusicIndex
    });

    let timeLeft = 120;
    io.to(roomName).emit('timerUpdate', timeLeft);

    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
      try {
        if (!rooms[roomName]) {
          clearInterval(room.timer);
          return;
        }

        timeLeft--;
        io.to(roomName).emit('timerUpdate', timeLeft);

        if (timeLeft <= 0) {
          clearInterval(room.timer);
          room.gameActive = false;

          io.to(roomName).emit('roundTimeout', { isChampionship: room.isChampionship });

          if (room.isChampionship) {
            scheduleNextRound(roomName, 12);
          }
        }
      } catch (err) {
        console.error('Hiba a round timer-ben:', err);
      }
    }, 1000);
  } catch (e) {
    console.error('Hiba a startNewRound függvényben:', e);
  }
}

function scheduleNextRound(roomName, seconds) {
  try {
    const room = rooms[roomName];
    if (!room) return;

    io.to(roomName).emit('autoNextRoundCounting', seconds);

    if (room.autoTimer) clearTimeout(room.autoTimer);
    room.autoTimer = setTimeout(() => {
      try {
        if (rooms[roomName] && rooms[roomName].isChampionship) {
          startNewRound(roomName);
        }
      } catch (err) {
        console.error('Hiba az autoNextRound timeout-ban:', err);
      }
    }, seconds * 1000);
  } catch (e) {
    console.error('Hiba a scheduleNextRound függvényben:', e);
  }
}

const PORT = process.env.PORT || 2500;
server.listen(PORT, () => {
  console.log(`Szószatyor 0.3Beta szerver elindult a ${PORT}-es porton!`);
});