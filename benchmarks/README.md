# Benchmarks

Standalone latency benchmarks for the translation engines. Not part of the app build.

## benchmark-soniox-endpoint-delay.cjs

Sweeps Soniox `max_endpoint_delay_ms` (300 / 1000 / 3000) to quantify how much
of the translation lag is tunable vs an API floor.

**Finding:** endpoint delay barely changes first-final latency (~3.8-4.1s); it
only changes segment granularity. The 2-3s lag is Soniox ASR finalize, not the
translation step (orig→trans gap is ~80ms). Full analysis:
[benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.md](benchmark-260602-1725-latency-3engine-and-soniox-endpoint-tuning-report.md).

### Run

```bash
cd benchmarks
npm install ws            # only dependency
# create .env.local with: SONIOX_API_KEY=...
node benchmark-soniox-endpoint-delay.cjs
```

Requires a 16kHz mono PCM s16le sample. By default reads
`../live-test/hope-v2-trim-16k.pcm` (gitignored dev artifact); override with:

```bash
BENCH_PCM_16K=/path/to/your-16k.pcm node benchmark-soniox-endpoint-delay.cjs
```

`.env.local` and `results/` are gitignored — never commit keys or raw transcripts.

## compare-with-teams-transcript.mjs

So sánh transcript của app với transcript Teams của **cùng buổi họp** và in 5 số
để theo dõi tiến bộ giữa các buổi: độ phủ theo người nói, tên riêng/thuật ngữ
nghe đúng, độ thuần nhãn người nói, tỉ lệ segment đệm, số action có người thật
và có ticket. Không gọi mạng, không cần `npm install`.

```bash
node benchmarks/compare-with-teams-transcript.mjs \
  --teams meeting/original-ja.md   # md xuất từ Teams/Stream, hoặc .vtt
  --app   meeting/original-vi.md   # note của app (Speaker N / [hh:mm:ss] / > ja) hoặc session .md
  --terms terms.txt --roster roster.txt   # tuỳ chọn: danh sách term, danh sách người
  --show-pairs 10                          # in mẫu cặp đã ghép để kiểm tra bằng mắt
  --json out.json
```

Ghép dòng theo thời gian (tự dò offset giữa hai đồng hồ, cửa sổ ±25 s) và chung
≥ 2 cụm 5 ký tự. Dòng Teams dưới 6 ký tự hoặc chỉ là うん/はい không tính vào
độ phủ. Term và roster của từng dự án nằm ngoài git (`docs/profiles/`).
