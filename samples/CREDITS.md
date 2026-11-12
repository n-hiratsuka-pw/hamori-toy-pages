# ドラムの音素材について

このフォルダの WAV は、次の録音素材から作成した（v0.9.2、2026-11-12 に試聴ページで選んだ組み合わせ）。

| アプリのパーツ | ファイル | 元の素材 | 作者 | ライセンス |
|---|---|---|---|---|
| バスドラム | kick.wav | **MuldjordKit** v1.0 — KdrumL #16 | Lars Muldjord（SFZ 版: kinwie） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| スネア | snare.wav | **Gogodze Phu Vol II** — sc vl5 rr1 | Karoryfer Lecolds | CC0 1.0 |
| タム（たかい） | tom_high.wav | **DRSKit** v1.0 — Tom1 #18 | DrumGizmo チーム（Lars Muldjord / Bent Bisballe Nyeng）・Jes Eiler（DRSDrums）（SFZ 版: kinwie） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| タム（ひくい） | tom_mid.wav | **DRSKit** v1.0 — Tom2 #12 | 同上 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| フロアタム | tom_floor.wav | **DRSKit** v1.0 — Tom3 #14 | 同上 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| ハイハット | hihat_1.wav, hihat_2.wav | **Virtuosity Drums** — hi-hat closed vl4 rr1・rr2 | Versilian Studios（録音: Virtuosity Musical Instruments, Boston／演奏: Austin McMahon） | CC0 1.0 |
| クラッシュ | crash.wav | **Big Rusty Drums** — crash_17 cr vl4 rr1 | Karoryfer Lecolds | CC0 1.0 |
| ライド | ride.wav | **Big Rusty Drums** — ride_22 rd vl7 rr1 | Karoryfer Lecolds | CC0 1.0 |

## 配布元

- MuldjordKit: https://github.com/sfzinstruments/DrumGizmo.MuldjordKit
- DRSKit: https://github.com/sfzinstruments/DrumGizmo.DRSKit
- Gogodze Phu Vol II: https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii
- Big Rusty Drums: https://github.com/sfzinstruments/karoryfer.big-rusty-drums
- Virtuosity Drums: https://github.com/sfzinstruments/virtuosity_drums

## 加工内容（CC BY 4.0 の「変更の表示」）

各パーツについて録音から 1 打を選び、近接マイク・オーバーヘッド・ルームの各マイクを混ぜてモノラルにし、立ち上がり前の無音と末尾を切り詰め、ピークを 0.9 にそろえた。
作り方は `../../tools/pick_kit.py`（ハイハットは `../../tools/mix_kit.py`）。CC0 の素材はクレジット表記の義務はないが、敬意を表して記載する。
アプリ画面では「設定（おうちの人用）」の下部に作者名とライセンスを表示している。
