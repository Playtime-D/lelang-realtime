const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Inisialisasi Database SQLite Lokal
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Gagal koneksi database:', err.message);
    else console.log('Terhubung ke database SQLite.');
});

// Buat Tabel Barang Lelang jika belum ada
db.run(`CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemName TEXT,
    category TEXT,
    startPrice INTEGER,
    bidIncrement INTEGER,
    currentPrice INTEGER,
    highestBidder TEXT,
    endTime INTEGER,
    status TEXT
)`);

// 1. API untuk Mengambil Daftar Semua Barang Lelang
app.get('/api/auctions', (req, res) => {
    db.all(`SELECT * FROM auctions`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 2. API untuk Menambah Barang Lelang Baru dari Admin
app.post('/api/auctions', (req, res) => {
    const { itemName, category, startPrice, bidIncrement, durationMinutes } = req.body;
    const endTime = Date.now() + (durationMinutes * 60 * 1000);

    const query = `INSERT INTO auctions (itemName, category, startPrice, bidIncrement, currentPrice, highestBidder, endTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [itemName, category, startPrice, bidIncrement, startPrice, "Belum ada", endTime, "active"], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Broadcast ke semua user/admin bahwa ada barang baru
        io.emit('refreshAuctions');
        res.json({ success: true, message: "Barang lelang berhasil ditambahkan!" });
    });
});

// 3. WebSocket untuk Proses Bidding Real-Time
io.on('connection', (socket) => {
    console.log('Pengguna terhubung:', socket.id);

    socket.on('placeBid', (data) => {
        const { auctionId, bidderName, amount } = data;
        
        db.get(`SELECT * FROM auctions WHERE id = ?`, [auctionId], (err, auction) => {
            if (!auction || auction.status !== 'active') {
                return socket.emit('bidResponse', { success: false, message: 'Lelang tidak aktif atau sudah selesai!' });
            }

            const minRequired = auction.currentPrice === auction.startPrice && auction.highestBidder === "Belum ada" 
                ? auction.startPrice 
                : auction.currentPrice + auction.bidIncrement;

            if (amount < minRequired) {
                return socket.emit('bidResponse', { 
                    success: false, 
                    message: `Penawaran terlalu rendah! Minimal bid Rp ${minRequired.toLocaleString('id-ID')}` 
                });
            }

            db.run(`UPDATE auctions SET currentPrice = ?, highestBidder = ? WHERE id = ?`, [amount, bidderName, auctionId], (updateErr) => {
                if (updateErr) return socket.emit('bidResponse', { success: false, message: 'Gagal memperbarui database.' });

                // Kirim pembaruan harga ke semua client yang terhubung
                io.emit('updateAuctionPrice', { auctionId, currentPrice: amount, highestBidder: bidderName });
                socket.emit('bidResponse', { success: true, message: 'Penawaran berhasil diajukan!' });
            });
        });
    });

    socket.on('disconnect', () => {
        console.log('Pengguna terputus:', socket.id);
    });
});

// Jalankan Server di Port 3000
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server lelang berjalan di http://localhost:${PORT}`);
});

// Pengecekan otomatis lelang kedaluwarsa setiap 1 detik di sisi server
setInterval(() => {
    const now = Date.now();

    // Cari barang yang masih aktif tapi waktu selesainya sudah terlewati
    db.all(`SELECT * FROM auctions WHERE status = 'active' AND endTime <= ?`, [now], (err, expiredAuctions) => {
        if (err || !expiredAuctions) return;

        expiredAuctions.forEach(auction => {
            // Ubah status di database menjadi 'ended'
            db.run(`UPDATE auctions SET status = 'ended' WHERE id = ?`, [auction.id], (updateErr) => {
                if (!updateErr) {
                    console.log(`Lelang barang #${auction.id} (${auction.itemName}) telah berakhir.`);
                    
                    // Broadcast ke semua user/admin bahwa lelang ini sudah ditutup
                    io.emit('auctionEnded', { 
                        auctionId: auction.id, 
                        highestBidder: auction.highestBidder,
                        finalPrice: auction.currentPrice 
                    });
                }
            });
        });
    });
}, 1000);