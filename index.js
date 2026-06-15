const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const port = 3000;

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","ngrok-skip-browser-warning"] }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ngrok-skip-browser-warning");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "webgis_tsunami_padang",
  password: "admin123",
  port: 5432,
});

pool.connect((err, client, release) => {
  if (err) return console.error("Gagal koneksi database:", err.stack);
  console.log("Koneksi database berhasil!");
  release();
});

app.get("/", (req, res) => res.send("Backend WebGIS Evakuasi Tsunami Padang"));

// ============================================================
// HELPER: Gabungkan koordinat segment jadi 1 LineString
// ============================================================
function gabungkanKoordinat(rows) {
  if (!rows || rows.length === 0) return [];
  const hasil = [];

  rows.forEach((row, idx) => {
    const geom = row.geometry;
    if (!geom) return;

    let titik = [];
    if (geom.type === "LineString") {
      titik = geom.coordinates;
    } else if (geom.type === "MultiLineString") {
      geom.coordinates.forEach((line) => titik.push(...line));
    } else return;

    if (titik.length === 0) return;

    if (idx === 0) {
      titik.forEach((pt) => hasil.push(pt));
    } else {
      const lastPt = hasil[hasil.length - 1];
      const firstPt = titik[0];
      const dx = Math.abs(lastPt[0] - firstPt[0]);
      const dy = Math.abs(lastPt[1] - firstPt[1]);
      if (dx > 0.0000001 || dy > 0.0000001) hasil.push(firstPt);
      titik.slice(1).forEach((pt) => hasil.push(pt));
    }
  });

  return hasil;
}

// ============================================================
// HELPER: Cari node terdekat dari komponen utama (component=1)
// Menggunakan tabel jaringan_ways_vertices_main yang hanya berisi
// node dari komponen terbesar (27.843 node) — dijamin terhubung
// ============================================================
async function cariNodeTerdekat(pool, lon, lat, kecualiId = null) {
  let sql, params;

  if (kecualiId !== null) {
    sql = `
      SELECT v.id,
        ST_Distance(v.geom::geography,
          ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS jarak_meter
      FROM public.jaringan_ways_vertices_main v
      WHERE v.id != $3
      ORDER BY v.geom <-> ST_SetSRID(ST_MakePoint($1,$2), 4326)
      LIMIT 1
    `;
    params = [lon, lat, kecualiId];
  } else {
    sql = `
      SELECT v.id,
        ST_Distance(v.geom::geography,
          ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS jarak_meter
      FROM public.jaringan_ways_vertices_main v
      ORDER BY v.geom <-> ST_SetSRID(ST_MakePoint($1,$2), 4326)
      LIMIT 1
    `;
    params = [lon, lat];
  }

  const res = await pool.query(sql, params);

  if (res.rows.length === 0) {
    // Fallback ke vertices_pgr kalau tabel main kosong (seharusnya tidak terjadi)
    console.warn("Fallback: jaringan_ways_vertices_main kosong");
    const fallback = kecualiId !== null
      ? await pool.query(
          `SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS jarak_meter
           FROM public.jaringan_ways_vertices_pgr WHERE id != $3
           ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`,
          [lon, lat, kecualiId])
      : await pool.query(
          `SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS jarak_meter
           FROM public.jaringan_ways_vertices_pgr
           ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`,
          [lon, lat]);
    return fallback.rows[0];
  }

  return res.rows[0];
}

// ============================================================
// ENDPOINT UTAMA
// ============================================================
app.get("/api/rute-otomatis", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon)
    return res
      .status(400)
      .json({ success: false, error: "Parameter lat dan lon wajib." });

  const userLon = parseFloat(lon);
  const userLat = parseFloat(lat);
  console.log(`\nRequest: lat=${userLat}, lon=${userLon}`);

  try {
    // STEP 1: Cari shelter terdekat (garis lurus)
    const shelterRes = await pool.query(
      `
      SELECT gid, nama_lokas,
        ST_Y(geom) AS s_lat, ST_X(geom) AS s_lon,
        ROUND(ST_Distance(geom::geography,
          ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)::numeric, 2) AS jarak_meter
      FROM public.titik_evakuasi_sektor_ab
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2), 4326)
      LIMIT 1
      `,
      [userLon, userLat]
    );

    if (shelterRes.rows.length === 0)
      return res.status(404).json({ success: false, message: "Tidak ada shelter." });

    const shelter = {
      nama: shelterRes.rows[0].nama_lokas,
      lat: parseFloat(shelterRes.rows[0].s_lat),
      lon: parseFloat(shelterRes.rows[0].s_lon),
      jarak_lurus_meter: parseFloat(shelterRes.rows[0].jarak_meter),
    };
    console.log(`Shelter: ${shelter.nama} (${shelter.jarak_lurus_meter}m lurus)`);

    // STEP 2: Source node — dari komponen utama, terdekat dari warga
    const srcNode = await cariNodeTerdekat(pool, userLon, userLat, null);
    const sourceNodeId = srcNode.id;
    console.log(`Source node: ${sourceNodeId} (${srcNode.jarak_meter?.toFixed(1)}m dari warga)`);

    // STEP 3: Target node — dari komponen utama, terdekat dari shelter, bukan source
    const tgtNode = await cariNodeTerdekat(pool, shelter.lon, shelter.lat, sourceNodeId);
    const targetNodeId = tgtNode.id;
    console.log(`Target node: ${targetNodeId} (${tgtNode.jarak_meter?.toFixed(1)}m dari shelter)`);

    // STEP 4: Hitung rute pgr_dijkstra dengan cost = length_m (meter)
    const ruteRes = await pool.query(
      `
      SELECT r.seq, r.node, r.edge, r.cost, r.agg_cost,
        ST_AsGeoJSON(
          CASE WHEN r.node = j.source THEN j.geom
               ELSE ST_Reverse(j.geom) END
        )::json AS geometry
      FROM pgr_dijkstra(
        'SELECT id, source::bigint, target::bigint, length_m AS cost
         FROM public.jaringan_ways WHERE length_m > 0 AND is_blocked = FALSE',
        $1::bigint, $2::bigint,
        directed := false
      ) AS r
      JOIN public.jaringan_ways AS j ON r.edge = j.id
      ORDER BY r.seq
      `,
      [sourceNodeId, targetNodeId]
    );

    console.log(`Segment rute: ${ruteRes.rows.length} ruas`);

    // STEP 5: Build response
    let geojsonRute, statusRute, totalJarakMeter;

    if (ruteRes.rows.length === 0) {
      console.warn("pgRouting kosong, fallback garis lurus");
      const fb = await pool.query(
        `SELECT ST_AsGeoJSON(ST_SetSRID(
          ST_MakeLine(ST_MakePoint($1,$2), ST_MakePoint($3,$4)),4326))::json AS geom`,
        [userLon, userLat, shelter.lon, shelter.lat]
      );

      geojsonRute = {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: fb.rows[0].geom,
          properties: { tipe: "fallback" },
        }],
      };
      statusRute = "fallback";
      totalJarakMeter = shelter.jarak_lurus_meter;

    } else {
      const semuaKoordinat = gabungkanKoordinat(ruteRes.rows);

      geojsonRute = {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: { type: "LineString", coordinates: semuaKoordinat },
          properties: {
            total_segment: ruteRes.rows.length,
            tipe: "pgr_dijkstra",
          },
        }],
      };

      totalJarakMeter = parseFloat(
        ruteRes.rows[ruteRes.rows.length - 1].agg_cost.toFixed(2)
      );
      statusRute = "sukses";
    }

    // STEP 6: Kirim response
    res.json({
      success: true,
      status_rute: statusRute,
      warga: { lat: userLat, lon: userLon },
      shelter: {
        nama: shelter.nama,
        lat: shelter.lat,
        lon: shelter.lon,
        jarak_lurus_meter: shelter.jarak_lurus_meter,
      },
      rute: geojsonRute,
      statistik: {
        total_segment: ruteRes.rows.length,
        total_jarak_meter: totalJarakMeter,
        total_jarak_km: (totalJarakMeter / 1000).toFixed(3),
        estimasi_jalan_kaki_menit: Math.ceil(totalJarakMeter / 80),
      },
      debug: { source_node_id: sourceNodeId, target_node_id: targetNodeId },
    });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// ENDPOINT BPBD — BLOKIR / BUKA JALAN
// ============================================================

// Blokir jalan terdekat dari koordinat klik
app.post("/api/jalan/blokir", async (req, res) => {
  const { lat, lon } = req.body;
  if (!lat || !lon)
    return res.status(400).json({ success: false, error: "Parameter lat dan lon wajib." });

  try {
    const result = await pool.query(
      `SELECT id, COALESCE(name, 'Jalan tanpa nama') AS name,
              ST_AsGeoJSON(geom)::json AS geometry,
              ST_Distance(geom::geography,
                ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS jarak_meter
       FROM public.jaringan_ways
       WHERE is_blocked = FALSE
       ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1,$2), 4326)
       LIMIT 1`,
      [parseFloat(lon), parseFloat(lat)]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: "Jalan tidak ditemukan." });

    const jalan = result.rows[0];

    await pool.query(
      `UPDATE public.jaringan_ways SET is_blocked = TRUE WHERE id = $1`,
      [jalan.id]
    );

    console.log(`[BPBD] Blokir jalan ID=${jalan.id} "${jalan.name}"`);

    res.json({
      success: true,
      message: `Jalan "${jalan.name}" (ID: ${jalan.id}) berhasil diblokir.`,
      jalan: {
        id: jalan.id,
        name: jalan.name,
        geometry: jalan.geometry,
        jarak_meter: parseFloat(jalan.jarak_meter).toFixed(1),
      },
    });
  } catch (err) {
    console.error("ERROR blokir:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Buka blokir jalan berdasarkan ID
app.post("/api/jalan/buka", async (req, res) => {
  const { id } = req.body;
  if (!id)
    return res.status(400).json({ success: false, error: "Parameter id wajib." });

  try {
    await pool.query(
      `UPDATE public.jaringan_ways SET is_blocked = FALSE WHERE id = $1`,
      [parseInt(id)]
    );

    console.log(`[BPBD] Buka blokir jalan ID=${id}`);
    res.json({ success: true, message: `Jalan ID ${id} berhasil dibuka kembali.` });
  } catch (err) {
    console.error("ERROR buka blokir:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ambil semua jalan yang diblokir sebagai GeoJSON
app.get("/api/jalan/diblokir", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, COALESCE(name, 'Jalan tanpa nama') AS name,
              ST_AsGeoJSON(geom)::json AS geometry
       FROM public.jaringan_ways
       WHERE is_blocked = TRUE
       ORDER BY id`
    );

    res.json({
      type: "FeatureCollection",
      total: result.rows.length,
      features: result.rows.map((row) => ({
        type: "Feature",
        geometry: row.geometry,
        properties: { id: row.id, name: row.name },
      })),
    });
  } catch (err) {
    console.error("ERROR get blocked:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ENDPOINT DEBUG
// ============================================================
app.get("/api/debug", async (req, res) => {
  try {
    const [ver, edges, verts, shelters, topo] = await Promise.all([
      pool.query("SELECT pgr_version() AS v"),
      pool.query("SELECT COUNT(*) AS n FROM public.jaringan_ways"),
      pool.query("SELECT COUNT(*) AS n FROM public.jaringan_ways_vertices_pgr"),
      pool.query("SELECT COUNT(*) AS n FROM public.titik_evakuasi_sektor_ab"),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE source IS NULL) AS null_source,
        COUNT(*) FILTER (WHERE target IS NULL) AS null_target,
        COUNT(*) FILTER (WHERE length_m IS NULL OR length_m <= 0) AS bad_cost
        FROM public.jaringan_ways`),
    ]);
    res.json({
      pgr_version: ver.rows[0].v,
      total_edges: parseInt(edges.rows[0].n),
      total_vertices: parseInt(verts.rows[0].n),
      total_shelter: parseInt(shelters.rows[0].n),
      topologi: topo.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`\nServer: http://localhost:${port}`);
  console.log(`Debug: http://localhost:${port}/api/debug\n`);
});