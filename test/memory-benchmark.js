/**
 * ============================================================================
 * CRDT Memory Footprint & Performance Benchmark
 * ============================================================================
 * Evaluates:
 * 1. Memory footprint over long document lifetimes (5,000 operations)
 * 2. Tombstone overhead & state vector scale
 * 3. Operation throughput (ops/second)
 * 4. Delta serialization and deserialization latency
 */

import { CRDTDoc } from '../public/js/crdt-core.js';

console.log('\n=============================================================');
console.log(' RUNNING CRDT MEMORY & THROUGHPUT BENCHMARK');
console.log('=============================================================\n');

const doc = new CRDTDoc('bench_client');
const TOTAL_OPS = 5000;
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n';

console.log(`Simulating ${TOTAL_OPS} realistic rich text operations (typing, formatting, backspacing)...`);

const startTime = Date.now();

for (let i = 0; i < TOTAL_OPS; i++) {
  const currentLen = doc.getText().length;

  if (currentLen > 10 && Math.random() < 0.20) {
    // 20% deletes
    const pos = Math.floor(Math.random() * currentLen);
    doc.delete(pos);
  } else if (currentLen > 5 && Math.random() < 0.10) {
    // 10% formatting changes
    const pos = Math.floor(Math.random() * (currentLen - 3));
    doc.format(pos, 3, { bold: true });
  } else {
    // 70% inserts
    const pos = Math.floor(Math.random() * (currentLen + 1));
    const char = chars[Math.floor(Math.random() * chars.length)];
    doc.insert(pos, char);
  }
}

const elapsedMs = Date.now() - startTime;
const opsPerSec = Math.round((TOTAL_OPS / (elapsedMs / 1000)));

const diag = doc.getDiagnostics();
const snapshot = doc.exportSnapshot();
const snapshotSerialized = JSON.stringify(snapshot);
const snapshotBytes = Buffer.byteLength(snapshotSerialized, 'utf8');

console.log('\n--- PERFORMANCE RESULTS ---');
console.log(`Operations Executed:      ${TOTAL_OPS.toLocaleString()} ops`);
console.log(`Execution Time:           ${elapsedMs} ms`);
console.log(`Throughput:               ${opsPerSec.toLocaleString()} ops/sec`);

console.log('\n--- MEMORY & CRDT METRICS ---');
console.log(`Final Visible Characters: ${diag.visibleCharacters.toLocaleString()} chars`);
console.log(`Total CRDT Items:         ${diag.totalItems.toLocaleString()} items`);
console.log(`Tombstones (Deletes):     ${diag.tombstoneCount.toLocaleString()} (${(diag.tombstoneRatio * 100).toFixed(1)}%)`);
console.log(`Estimated Memory Usage:   ${(diag.estimatedMemoryBytes / 1024).toFixed(2)} KB`);
console.log(`Serialized Snapshot Size: ${(snapshotBytes / 1024).toFixed(2)} KB`);
console.log(`Average Bytes / Item:     ${(snapshotBytes / diag.totalItems).toFixed(1)} bytes`);
console.log(`State Vector Clock:       ${JSON.stringify(diag.stateVector)}`);

console.log('\n--- BENCHMARK VERIFICATION ---');
if (opsPerSec > 2000) {
  console.log('✓ PASS: Throughput exceeds 2,000 ops/sec threshold (Production Grade)');
} else {
  console.log('! WARN: Throughput below optimal threshold');
}

if (snapshotBytes / diag.totalItems < 500) {
  console.log('✓ PASS: Memory footprint is compact (<500 bytes per node)');
} else {
  console.log('! WARN: Memory footprint higher than recommended');
}

console.log('\n=============================================================\n');
