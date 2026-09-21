/*
 * English version of the MML command reference / demo (see sampleMml.js).
 *
 * The MML itself is identical to the Japanese version, byte for byte, apart from the
 * comments. tools/headless/help-lint.js strips every comment from both files and
 * requires the remainder to match, so the two cannot drift apart unnoticed.
 * When you edit the Japanese reference, edit this one the same way.
 * NOTE: a backtick and a dollar-brace cannot appear in the MML below (it would break
 * the template literal).
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

  Mml.SAMPLE_SOURCE_EN =`
; ================================================================
;  Sound Emulation Foundry - MML command reference & demo
; ================================================================
;  This file is both the reference and the sample: it plays each of the MML
;  commands this tool supports while the comments explain them. Read the
;  comment next to whatever is playing and you can hear what the command does.
;
;  * The chapters (A -> C -> D -> E -> F -> VRC7 -> VRC6 -> N163 -> SUNSOFT 5B -> MMC5)
;    play one after another. A line such as "GHIJKL [r1]41" at the top of a chapter is
;    a rest that waits for the previous chapter to finish; its length is computed and
;    written by tools/headless/sample-sequence.js (do not edit it by hand).
;    To hear just one item, use the per-item play button in the help window
;    (the "?" button on the MML editor header).
;

;@help #TITLE #COMPOSER #MAKER #PROGRAMER :: Metadata :: Header
; Title / composer / year / programmer. Written straight into the NSF header
; (no effect on playback)
#TITLE MML Reference & Demo
#COMPOSER Sound Emulation Foundry
#MAKER 2026
#PROGRAMER Sound Emulation Foundry

;@help #EX-VRC6 #EX-VRC7 #EX-DISKFM #EX-MMC5 #EX-N163 #EX-NAMCO106 #EX-SUNSOFT5B #EX-FME7 :: Declaring expansion chips :: Header
; Channel assignment and the declaration of the expansion chips to use. Writing #EX-*
; adds that chip's channels.
;  Channel table:
;    A = 2A03 pulse 1     ... basics (notes / lengths / octave / tie / rest / loop / tuplet /
;                             direct pitch / gate / tempo / transpose / detune / wait /
;                             raw register write / embedded data), followed by
;                             volume (v / v+ / v- / @v / @vr / SD / SDOF / SDQR / sweep) and
;                             tone (a duty envelope defined with @<n>={...}, selected by @@ / @@r)
;    B = 2A03 pulse 2     ... unused in this sample (volume and tone are all on A)
;    C = 2A03 triangle    ... pitch (EP / EN / MP / PT / PS / SM)
;    D = 2A03 noise       ... period index / short period, a drum kit made from noise
;                             (@v / @EP / macros), EN / EP, the loop marker "L" (described only)
;    E = DPCM (1ch)       ... @DPCM definitions and how .dmc files are handled, note = sample
;                             number (no pitch, as in ppmck), how to stop it, splitting a long
;                             sample (the .dmc files referenced here are not in the store, so
;                             they warn and stay silent)


; Expansion chip declarations:
;    F = FDS (1ch)        ... custom waveform (@FM) + pitch modulation (@MW / @MH / MH / MHOF)
#EX-DISKFM

;    G-L = VRC7 (FM 6ch)  ... custom tone (@OT -> OP / OPOF) + the tones in ROM (@1-@15)
#EX-VRC7

;    M-O = VRC6 (3ch)     ... two pulse channels with switchable duty (@<n>) + a sawtooth
#EX-VRC6

;    P-W = N163 (8ch)     ... a chord pad (8 voices) on custom waveforms (@N -> @<n>)
#EX-N163 8

;    X-Z = SUNSOFT 5B (3ch)   ... mixer (@<n>) + hardware envelope (S / M) + noise (N)
#EX-SUNSOFT5B

;    a-b = MMC5 (2ch)     ... two pulses, and a demo of reusing a macro "$"
#EX-MMC5

;@help N163 :: N163: active channels, wave RAM, volume, range :: Header :: nodemo
; N163 time-multiplexes up to 8 channels, and the number after #EX-N163 is how many are
; actually played (omit it and it is detected from the MML; #EX-NAMCO106 is the old
; spelling of the same thing). Changing that number moves three things at once.
;
;  * Wave RAM ... the waveforms share 128 - 8 x channels bytes (one sample = 4 bits)
;      1ch=120 bytes (240 samples) 2ch=112 4ch=96 6ch=80 8ch=64 bytes (128 samples)
;  * Volume   ... the output is averaged over the active channels, so the same v is louder
;      with fewer channels: 1ch is 5x the level of 5ch, 8x that of 8ch (this is what the real
;      time-multiplexed output does; the MML side does not compensate)
;  * Frequency ... freqReg = pitch x 15 x 65536 x wave length x channels / CPU clock (18 bits)
;      With fewer channels the register value is smaller: the pitch steps get coarser, but the
;      highest playable note goes up
;
; Highest playable note (wave length x channels; anything past 18 bits will not sound)
;         1ch   2ch   3ch   4ch   5ch   6ch   7ch   8ch
;    4    a+12  a+11  d+11  a+10  f+10  d+10  c10   a+9
;    8    a+11  a+10  d+10  a+9   f+9   d+9   c9    a+8
;   16    a+10  a+9   d+9   a+8   f+8   d+8   c8    a+7
;   32    a+9   a+8   d+8   a+7   f+7   d+7   c7    a+6
;   64    a+8   a+7   d+7   a+6   f+6   d+6   c6    a+5
;  128    a+7   a+6   d+6   a+5   f+5   d+5   c5    a+4
;  256    a+6   a+5   d+5   a+4   f+4   d+4   c4    a+3
; The lowest note is far below the audible range in every combination, so only the ceiling
; matters in practice.
; * Notes in this tool stop at o9b (see "Range"). Even for a combination that the table puts
; at o10 or above, o9b is as high as you can write.
; Halving the wave length raises the ceiling by an octave (at the cost of a duller timbre).
; When converting a song to MML, "Conversion settings -> N163" chooses the channel count and
; whether waveforms are shrunk to fit the RAM and the range.

;@help #OCTAVE-REV #GATE-DENOM #AUTO-BANKSWITCH #BANK-CHANGE #SETBANK #NO-BANKSWITCH #INCLUDE #EFFECT-INCLUDE :: Header directives :: Header :: nodemo
; Directives that exist but are not used in this sample (they affect the whole song, so they
; are only described here, not executed):
;   #OCTAVE-REV       ... swaps the meaning of ">" and "<" (octave up / down)
;   #GATE-DENOM <n>   ... changes the gate denominator of q<n> (8 by default)
;   #AUTO-BANKSWITCH / #BANK-CHANGE <n> / #SETBANK <n> / #NO-BANKSWITCH
;                     ... choose the bank switching scheme used when exporting NSF
;   #INCLUDE          ... recognised and ignored (including external files is not supported)
;@help #TUNING :: Reference pitch (global offset, in cents) :: Header :: nodemo
;   #TUNING <cent>    ... shifts every note away from 12-tone equal temperament (A4=440Hz) by
;                       this many cents (decimals allowed, e.g. #TUNING +29.3). Note names do
;                       not change: this is not a key change or a transpose, it is the same as
;                       tuning the whole instrument to, say, A4=447Hz.
;                       Converting a song to MML detects the song's overall deviation and
;                       writes it here ("Reference pitch" in the conversion settings).
;                       Browser playback and the exported NSF are shifted by the same amount
;@help #TUNING-NOTE :: Per-note-name tuning (offset per pitch class, in cents) :: Header :: nodemo
;   #TUNING-NOTE <name> <cent> ...
;                     ... shifts only that note name, in every octave, by this many cents
;                       (e.g. #TUNING-NOTE f+ +33 c+ +10 ... F# by +33 and C# by +10 cents).
;                       Names are c d e f g a b with + / # (sharp) or - (flat); anything not
;                       listed is 0. This reproduces songs whose driver has a frequency table
;                       that departs from equal temperament note by note (i.e. the game itself
;                       was tuned that way). Combined with #TUNING the two are added.
;                       Conversion writes it automatically with "Reference pitch: detect per
;                       note name". An extension of this tool (ppmck has no equivalent)
;@help ;@time ;@key :: Time signature and key for the score (comment directives) :: Header :: nodemo
; ppmck's MML has no concept of a time signature or a key. The values needed only when
; producing a score (MusicXML export / staff view) are given on comment lines that ppmckc
; ignores, so playback is not affected at all. Without them the score assumes 4/4 and guesses
; the key from the notes (only the first occurrence of each is used):
;   ;@time 3/4        ... time signature (the denominator may be 1/2/4/8/16/32/64)
;   ;@key -1          ... key signature, as a position on the circle of fifths (sharps positive,
;                       flats negative; -1 = F major / D minor, 2 = D major / B minor)
;@time 4/4
;@key 0

; ================================================================
;  About the envelope and tone definitions
;  * A definition line such as "@v0 = {...}" may appear anywhere in the MML and is
;    referred to by its number in the body. ppmckc's convention is to gather them all
;    at the top of the song; this sample instead puts each one right above the channel
;    that uses it, which is easier to read.
; ================================================================

; ================================================================
;  Special markers (writing one really does change playback, so they are described only)
; ================================================================
;@help ! !! !!! :: Special markers (skip / play range) :: Special :: nodemo
; "!" (one)    ... skip data. From this mark on, nothing in that channel is compiled
;                (i.e. silence). Handy for muting a part you are still working on.
; "!!" (two)   ... start of playback, tied to the blue handle on the seek bar.
; "!!!" (three)... end of playback (an extension of this tool; ppmckc has no equivalent),
;                tied to the red handle. Without it the song plays to the end.

; ================================================================
;  A: basics (notes, lengths, octave, tie, rest, loop, tuplet, direct pitch,
;     gate, tempo, transpose, detune, wait, raw register write, embedded data)
; ================================================================
;@help y<adr>,<num> :: Raw register write :: Special
; y<addr>,<val>: writes straight to a register ("$" prefix for hex). Here it is a harmless
; example that writes "enable the four 2A03 channels (2 pulses / triangle / noise)" to $4015
; (bit 4, the DMC, is not included; normally the commands manage this for you). For stopping
; DPCM in the middle, see the E channel below
A y$4015,$0f

;@help x<p0>,<p1> :: Embedded data :: Special
; x<p0>,<p1>: embeds bytes directly into the data stream (for NSF export only; browser
; playback parses and ignores it)
A x$00,$00
A t100 l4 o4 v12 @0

;@help c d e f g a b l<n>[.] :: Notes and lengths :: Basics
; Notes c d e f g a b; "+"/"#" = sharp, "-" = flat, a number = length, "." = dotted
A c d e f g a b >c<

;@help o<n> > < :: Octave :: Basics
; Octave: o<n> sets it directly, "<" and ">" move it one step.
; The usable range is o0c-o9b (o9 is an extension of this tool; ppmck stops at o8b). See the
; "Range" item for the range and the per-chip ceilings
A o5 c o4 c >c <c

;@help Range :: Range per sound chip (real hardware / this tool / ppmck) :: Basics :: nodemo
; Notes in this tool run from o0c to o9b (numbered 0-119). Anything above (o10 and up) or below
; (o-1) warns and does not sound. A note past a chip's own ceiling is treated the same way.
; Browser playback and NSF export behave identically and sound the same.
;
; * o9 is an extension of this tool. ppmck's notes stop at o8b and anything higher is clamped
;   to o8b. To play above o8b in MML destined for ppmck, write @n<period> instead (see
;   "Direct frequency").
; * The frequency table written into an exported NSF stops at o8b. It is extended to o9b only
;   for the chips that actually use an o9 note (+24 bytes for that chip, +36 for N163). An NSF
;   for a song that stays within o8b is unchanged. Playing o9 with @n alone does not extend the
;   table (but costs 3 bytes per note, so a song with many o9 notes is smaller and faster with
;   the table).
; * The higher the note, the coarser the period steps, so equal temperament is not exact.
;   For example o9b on SUNSOFT 5B is period 4 = 13983Hz, about two semitones below the 15804Hz
;   of equal temperament; above o9f+ there are only two values left, period 5 and 4.
;
; Range per chip (real hardware / this tool / ppmck)
;  2A03 pulse      hardware 54.6Hz (o1a) - 12.4kHz (o9g; below period 8 the sweep unit mutes it)
;                  this tool o1a-o9g / ppmck o1a-o9g (o8b is about a semitone flat because the
;                  table is truncated)
;  2A03 triangle   hardware 27.3Hz (o0a) - 18.6kHz / this tool o0a-o9b
;                  ppmck writes o1a-o10b (ppmck uses the pulse table for the triangle, so it
;                  really sounds an octave below what is written)
;  VRC6 pulse      hardware 27.3Hz (o0a) - ultrasonic / this tool o0a-o9g / ppmck o1c-o8b
;  VRC6 sawtooth   hardware 31.2Hz - ultrasonic / this tool o1c-o9b / ppmck o1c-o8b
;  MMC5 pulse      hardware 54.6Hz - (no sweep unit, so periods below 8 sound) / this tool
;                  o1a-o9g / ppmck o2c-o8b
;  SUNSOFT 5B      hardware 13.7Hz - 55.9kHz (period 1) / this tool o0c-o9b / ppmck o-1a-o8b
;  FDS             hardware - 1747Hz (4095, the maximum of the 12-bit frequency register) /
;                  this tool and ppmck both - o6g+
;  N163            the ceiling depends on the wave length and the active channel count (see the
;                  table in "N163") / this tool - o9b / ppmck - o8a
;  VRC7            hardware - 6202Hz (fnum 511, block 7) / this tool - o8f+ / ppmck o0c-o7b
;  Noise           16 periods (note names c-b = index 0-11, n12-n15 are literal; the octave is
;                  irrelevant, same as ppmck)
;  DPCM            16 rates. A note is a sample number and carries no pitch (same as ppmck)

;@help & :: Tie (legato) :: Basics
; Tie "&": joins note values. At the same pitch it simply extends the length; at a different
; pitch it becomes a legato that "changes pitch without re-attacking" (it only rewrites the
; frequency of a note that is already sounding, so the volume envelope keeps running instead
; of starting over). For a pitch that slides, use PT or PS.
; * D / EP / MP / @v written before the second or later note of a tie have no effect (the
;   settings at the head of the chain keep running).
; * Legato at a different pitch is an extension of this tool. ppmck's "&" only adds the length
;   of the next note, so d4&e8 sounds d for a quarter plus an eighth (the pitch of e is thrown
;   away). In MML that must also play under ppmck, use "&" only at the same pitch
A c4&c8 d4&e8&e8

;@help r :: Rest :: Basics
; Rest "r", and a dotted rest
A r4 r8. c8

;@help {...}<len> :: Tuplet :: Basics
; Tuplet "{...}<len>": divides the notes inside evenly over <len> (a triplet here)
A {ceg}4 {ceg}4

;@help [...]n :: Repeat :: Basics
; Repeat "[...]n": plays the contents n times
A [c8d8]2
;@help [...|...]n :: Skipping the last pass of a repeat :: Basics
; "[... | ...]n": on the final pass, everything after "|" is not played
A [e8f8g8|g8]3
;@help n<num>[,<len>] :: Direct pitch :: Basics
; Direct pitch n<num>[,<len>], numbered from 0 at the C of o2. Here o4 C, E, G and o5 C
A n24,4 n28,4 n31,4 n36,4
;@help @n<num>[,<len>] :: Direct frequency :: Basics
; Direct frequency @n<num>[,<len>] (from ppmck): bypasses the scale and writes the value of the
; period (frequency) register itself. <num> is decimal or "$" hex ("x" hex and "%" binary also
; work). A larger value is a lower note, and one octave up halves it (o4c on a pulse is $1AB,
; o5c is $0D5). FDS is the exception: its register is a frequency, so larger is higher. 2A03 and
; MMC5 take the low 11 bits, VRC6 / SUNSOFT 5B / FDS 12 bits, and anything past that is
; truncated with a warning, as in ppmck. On the noise channel the low byte goes straight to
; $400E (low 4 bits = period index, $80 and up = short period). Not available on VRC7, N163 or
; DPCM (an error, as in ppmck). As in ppmck, D<n> has no effect while EP and MP do; the pitch
; after "&" is discarded and only its length is added; EN has no effect (with a warning)
A @n$1AB,4 @n$17C,4 @n$152,4 @n$0D5,4
;@help q<n>[,<m>] @q<n> :: Gate time :: Basics
; Gate time q<n> (0-8, 8 by default = the full length of the note; smaller cuts it shorter and
; leaves a gap). The sounding length is floor(length x n / 8) frames, as in ppmck. q<n>,<m>
; adds or subtracts m frames
A q8 c4 q4 c4 q2 c4 q6,-2 c4 q8
;@help k<len> @k<n> :: Key off :: Basics
; k<len>: keys off the previous note right there and waits for <len> (a rest during which the
;   release runs, if @vr is set).
; @k<n>: from here on, notes key off <n> frames after key on (overrides q and @q; @k0 cancels).
;   This lets you write "sound for a fixed time, then wait for the next note" in one command
;   while the note length still means the interval between notes
A @vr0 c8 k8 d8 k8 @k6 e8 e8 e16 e16 @k0 c4
; @q<n> is given in frames and keys off <n> frames before the end of the note. Unlike q<n>,
; which is proportional to the note length, the gap stays the same at any length. @q0 cancels
A @q10 c4 c2 @q0 c4
;@help t<n> K<n> D<n> :: Tempo, transpose, detune :: Basics
; The tempo t can be changed anywhere in the song. K<n> transposes in semitones; D<n> detunes
; by a raw register difference (on every chip a positive value raises the pitch: this is the
; direction you get with ppmck's #PITCH-CORRECTION always applied, and NSF export converts it
; to each chip's own register direction). D255 means "cancel", the same as D0 (as in ppmck)
A t120 K2 c4 K0 D8 c4 D0 t100
;@help @t<len>,<num> :: Tempo 2 (in frames) :: Basics
; @t<len>,<num>: works out the tempo at which a note of <len> is exactly <num> frames long.
; t<n> is rounded to an integer BPM and leaves a remainder; this sets the frame count directly.
; Here a quarter note is made 30 frames (0.5s, the same as BPM 120 at 60fps) and then the
; original t100 is restored
A @t4,30 c4 c4 c4 c4 t100
;@help w<len> :: Wait :: Basics
; Wait "w<len>": extends the preceding note / rest / w by another <len> (the same mechanism as
; a tie)
A c4 w4

; ================================================================
;  A (continued): volume (v / v+ / v- / @v / @vr / SD / SDOF / SDQR / sweep) and tone (@@ / @@r)
;  These follow on from "basics" above and play in order on the same channel A
; ================================================================
A t100 l4 o4 @1
;@help v<n> v+<n> v-<n> :: Volume :: Volume
; Volume v<n> (0-15), relative v+<n> / v-<n> (1 if the number is omitted). On every chip a
; larger value is louder (v15 is the maximum on VRC7 too: the hardware $30+ch register holds an
; attenuation, but the compiler does the inverting).
; * FDS (F) and the VRC6 sawtooth (O) are the exception and take the raw register value v0-63,
;   as in ppmck (FDS = the $4080 gain, effectively clipped at 32, v32 if unset / VRC6 sawtooth =
;   the $B000 accumulation rate, v63 if unset. * The real maximum is v42: the output is the top
;   5 bits of an 8-bit accumulator, so at 42 the peak already reaches the ceiling (31) and v43
;   and above only overflow and break up the waveform without getting louder - in effect
;   v42 is about v50 and louder than v63. Unless you want that as a timbre, stay at 42 or below;
;   the keyboard volume bar also treats 42 as 100%).
;   Writing v16 or more on any other channel is an error. Table values in @v / @vr are read in
;   the same range, so sharing a 0-15 table with FDS or the sawtooth sounds quiet (it is not
;   treated as an error)
A v8 c4 v+4 c4 v-2 c4 v15 c4
;@help @v<n> :: Volume envelope :: Volume
; --- Volume envelope @v<n> = { a volume (0-15) per frame }.
;     A "|" marks the loop point: on reaching the end it goes back there and continues.
;     Without one it does not loop and holds the last value. ---
@v0 = { 15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0 }        ; a plain decay (no loop)
@v1 = { 12,15,12,9 | 12,15,12,9 }                       ; tremolo (the whole table loops)
@vr0 = { 8,6,4,2,0 }                                    ; for release (called by "@vr0" below)

; Volume envelope @v<n> (defined on the lines just above): each note follows the table one
; frame at a time
A @v0 c1
A @v1 c1 c1
;@help @vr<n> :: Release envelope :: Volume
; Release envelope @vr<n>: written exactly like @v<n>
;   ( @vr<n> = { a volume (0-15) per frame..., "|" for the loop point }; in this song it is
;     defined above as @vr0 = { 8,6,4,2,0 } ). Only the timing differs: @v<n> is followed from
;   key on, while @vr<n> starts at the top of its table the moment the gate closes (key off).
; * Without q<n> (n<8) to close the gate there is no release section at all and nothing happens
;   (the default q8 sounds for the full length of the note; real ppmck behaves the same way).
;   It fires whether or not there is a @v<n> volume envelope, so a note at a fixed v<n> gets a
;   release too. If there is no @vr<n> definition, the @v<n> of the same number is used.
;   @vr255 cancels it
A q6 @vr0 v10 c2 r2
;@help SD<n> SDOF SDQR :: Self delay (a pseudo echo) :: Volume
; Self delay SD<n> (a pseudo echo): replaces the pitch of the release section with the one from
; <n> key-ons ago and re-triggers it there. It needs both @vr<n> and q<n> (n<8).
; <n> is 0-8, SD255 is the same as SDOF, and it cannot be used on the triangle or on DPCM.
; SDOF turns it off; SDQR resets the key-on history (how far back it can reach)
A SD1 q6 @vr0 v10 c4 e4 g4 r4
A SDOF SDQR q8
;@help @<n>={...} @@<n> :: Duty envelope :: Tone
; --- Duty (tone) envelope @<n> = { a duty ratio (0-7) per frame }.
;     The tone counterpart of @v<n>, selected in the body with @@<n> ("|" marks the loop the
;     same way).
;     * A definition "@<n> = {...}" and a plain "@<n>" in the body (choosing a fixed duty) are
;     two different things.
;     Valid values are 0-3 on 2A03 and MMC5 pulses, 0-7 on VRC6 pulses. ---
@0 = { 0,1,2,3 }                                         ; 12.5 -> 25 -> 50 -> 75%, one frame each
@1 = { 2 | 1,2 }                                         ; starts at 50%, then alternates 25%/50%

; Duty (tone) envelope @@<n> (defined by the "@<n> = {...}" lines just above). The tone
; counterpart of @v<n>: the duty ratio changes one frame at a time. Writing @<n> (a fixed duty)
; cancels it, as on real hardware
A @@0 v12 c2 @@1 c2 @2 c2
;@help @@r<n> :: Release tone :: Tone
; Release tone @@r<n> (255 = off): swaps the tone the moment the gate closes (the tone
; counterpart of @vr). Here @@0 (a rising duty) runs while the gate is open and the release
; section switches to @@1
A q4 @@0 @@r1 @vr0 v12 c2 r2
A @@r255 @1 q8
;@help s<n0>,<n1> :: Sweep :: Tone
; Sweep s<speed>,<depth>: a single write to the hardware sweep unit of a 2A03 pulse
; ($4001/$4005), exactly as on hardware (pulses A and B only; the triangle, the noise and the
; expansion chips have no such unit). The low 4 bits of depth (0-15) are the sign and the shift
; amount as they are; only the conversion from speed (1 fastest to 15 slowest, 0 = off) to the
; hardware period (0-7) is an approximation
A s2,1 o3 v10 c1
A s0,0

; ================================================================
;  C: pitch (EP / EN / MP / PT / PS / SM)
; ================================================================
C [r1]25 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
C t100 l4 o4 v14
;@help @EP<n> EP<n> EPOF :: Pitch envelope :: Pitch
; --- Pitch envelope @EP<n> = { signed deltas in raw register offsets, accumulated }.
;     As with D<n>, a positive value raises the pitch on every chip. Like EN, making the sum of
;     the looped section zero repeats a bend back and forth forever. A table without "|" keeps
;     adding its last value every frame (as in ppmck), so end it with 0 to stop. ---
@EP0 = { 0 | -2,-2,-2,2,2,2 }                            ; a bend going 0 -> -6 -> 0 -> ...

; Pitch envelope EP<n>[,<delay>] / EPOF (defined by the @EP<n> above; <delay> is optional and
; holds the effect back by that many frames - an extension of this tool)
C EP0 c1 EPOF c1
;@help @EN<n> EN<n> ENOF :: Note envelope (fast arpeggio) :: Pitch
; --- Note envelope @EN<n> = { semitones relative to the previous value, accumulated }.
;     Used for fast arpeggios. Making the sum of the looped section zero repeats the same shape
;     forever. A table without "|" stops at its total when it reaches the end (ppmck keeps
;     adding the last value, so end it with 0 if you are writing for ppmck; EP does keep adding,
;     as ppmck does). ---
@EN0 = { 0 | 4,3,-3,-4 }                                 ; 0 -> +4 -> +7 -> +4 -> 0 (a major chord)

; Note envelope (fast arpeggio) EN<n> / ENOF
C EN0 c1 ENOF c1
;@help @MP<n> MP<n> MPOF :: Vibrato :: Pitch
; --- Vibrato @MP<n> = { delay, speed, depth } (a faithful port of the hardware lfo_sub, so the
;     movement is stepped rather than smooth) ---
@MP0 = { 0, 4, 3 }                                       ; delay 0 frames, speed 4, depth 3

; Vibrato MP<n> / MPOF
C MP0 c1 MPOF c1
;@help PT<target>,<duration>[,<delay>] PTOF :: Portamento :: Pitch
; Portamento PT<target>,<duration>[,<delay>] / PTOF: glides linearly to a raw register offset
; over <duration> frames. An extension of this tool; ppmck has no such command. As with D<n>
; and EP, a positive target raises the pitch on every chip
C PT-40,30 c2 PTOF c2
;@help PS :: Pitch shift (simple portamento) :: Pitch
; PS: a simple portamento that uses the next note itself as the destination (a ppmck command).
; On hardware only the first cycle has a different interval, so the glide can run into the next
; note; this tool approximates it with even steps instead
C c4 PS g4 PS c4 r4
;@help SM SMOF :: Suppressing the click in a legato :: Pitch
; SM / SMOF: prevents the click when slurring within one octave (the pitch itself does not
; glide)
C SM c4&e4&g4 SMOF

; ================================================================
;  D: noise (percussion) and the loop marker "L"
; ================================================================
D [r1]35 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help n<num>(noise) @<n>(noise) :: Noise period, short and long :: Basics
; The pitch of the noise channel is a "period index" from 0 to 15 (as in ppmck). n0 is the
; fastest (highest) noise and n15 the slowest (lowest). For the note names c-b the semitone
; number 0-11 is the index itself (the octave is ignored, and K (transpose) is ignored with a
; warning; c = 0 = the highest). 12 to 15 can only be written as n12-n15. n16 and above wrap at
; 16 and warn.
; @0 = long period (the default, white noise) / @1 = short period (a 93-step periodic noise
; with a metallic sense of pitch). "@" here is this tool's own spelling; ppmck treats "@" on
; the noise channel as an error.
; D<n> subtracts from the index (D-1 n4 is the same as n5). The ppmck idiom "D16 n0-n15" sets
; bit 7 through an 8-bit overflow and switches to the short period (the same sound as @1; use
; this if you are writing for ppmck). D0 to D-15 stay on the long period. D255 cancels it
D t100 l8 v10
D n15 n12 n10 n8 n6 n4 n2 n0 r2
D @1 n15 n12 n10 n8 n6 n4 n2 n0 @0 r2
D D16 n4 n4 D0 n4 n4 r2
D [c d]4 r4 [e f]4 r4
D q4 c8c8c8c8 q8
;@help Noise-drum-kit :: A drum kit made from noise (@v + @EP + macros) :: Techniques
; The noise channel is a single monophonic voice, so each drum gets its own pairing of a period
; index with a volume envelope (and sometimes a pitch envelope). The values below are the same
; as the built-in noise pad presets in the drum (DPCM / noise) panel, and converting a song to
; MML with a pad targeted at "noise (D)" writes out notes in exactly this shape:
;   closed hi-hat ... n1  @v10 = {12,8,4,0}                 cut short
;   open hi-hat   ... n2  @v11 = {12,11,...,1,0}            a longer decay
;   snare         ... n6  @v12 = {15,13,11,9,7,5,3,1,0}
;   kick          ... n11 @v13 = {15,12,8,4,0} + @EP2       the pitch falls (EP is positive = up,
;                                                           so it takes negative values)
;   tom           ... n8  @1 @v14 + @EP2                    the short period gives it a "pitch"
; * As in ppmck, @EP without a "|" keeps adding its last value, so put a 0 at the end to stop it.
; * Every new note cuts the previous one off (last one wins). Two cannot sound at once, so on a
;   beat where the kick and the hi-hat collide one of them has to go (when converting, the noise
;   pads decide this by the priority of each pad)
@v10 = { 12,8,4,0 }
@v11 = { 12,11,10,9,8,7,6,5,4,3,2,1,0 }
@v12 = { 15,13,11,9,7,5,3,1,0 }
@v13 = { 15,12,8,4,0 }
@v14 = { 15,12,9,6,3,0 }
@EP2 = { 0,-1,-1,-1,0 }
; Folding "tone plus note" into a single character with a macro makes the pattern much easier to
; read. A macro is a one-character substitution shared by every channel, so pick an unused
; character that does not collide with a command (h, j and u here)
$h @0 @v10 EPOF n1
$j @0 @v12 EPOF n6
$u @0 @v13 EP2 n11
D l8 u h j h u u j h
D l8 u h j h u u @1 @v14 EP2 n8 n8 @0
D l16 @v11 EPOF n2 r8. @v10 n1 n1 n1 n1 @v12 n6 n6 r8
;@help EN(noise) EP(noise) :: EN and EP on the noise channel (moving the period) :: Techniques
; EN and EP work on the noise channel too. EN adds to the index (+1 lowers the pitch, and it
; wraps at 16; ppmck wraps at 12, which breaks n12-n15), while EP subtracts from it (positive =
; higher, the same as every other chip). Both keep adding their last value without a "|".
; Adding 1 forever with EN gives the falling noise sweep used as a sound effect
@EN1 = { 0 | 1 }
D l2 @0 v10 EN1 n0 ENOF r2
;@help L :: Loop marker :: Basics :: nodemo
; Loop marker "L": when this channel reaches the end it goes back to the nearest "L" and repeats
; everything from there forever (this is how you mark where the whole song loops; it is not the
; same as the [...]n repeat).
; A channel with no "L" repeats from its beginning when it reaches the end (as in ppmck).
; In browser playback the "song length" on the seek bar runs until it has returned to L twice
; (one intro plus two passes of the loop); an exported NSF loops forever, as on hardware.
; For example:
;   D c8c8c8c8 L c16r16c16r16c16r16c16r16   ... the first half is the intro, L onward repeats
; * This sample plays its chapters one after another, so there is no L anywhere in it (a single
;   L would make the finished channel repeat from the top and pile every part on top of the
;   others). Like "!", "!!" and "!!!", it is described only

; ================================================================
;  E: DPCM (1ch) - definitions and .dmc files / note = sample number / stopping it /
;     splitting a long sample
; ================================================================
E [r1]47 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @DPCM<n> :: DPCM sample definitions and .dmc files :: Expansion chips
; --- DPCM sample definition @DPCM<n> = { "filename", freq, size, dac, mode } (the same syntax
;     as ppmck; n is 0-63)
;     freq ... the playback rate (index 0-15 in the DMC rate table; 15 = 33.1kHz is the highest,
;              0 = 4.2kHz). A definition always plays at this rate
;     size ... in ppmck this is the number of bytes to play (0 = the file size). This tool uses
;              the actual data length, so it is read and discarded
;     dac  ... the initial DAC value (0-127) written to $4011 when the sample starts. 255 means
;              do not write (same as ppmck)
;     mode ... 0 = play once / 1 = loop (2 = IRQ is discouraged even in ppmck and is ignored
;              here). Everything from size on may be omitted
;     A single definition is enough to enable the E channel automatically (there is no #EX-*
;     declaration for it).
;     Definitions with the same filename share their data (as in ppmckc), so listing several
;     rates of the same file does not grow the ROM.
;     A .dmc file is not embedded in the MML; as in ppmck it lives "in the same folder as the
;     .mml":
;       * Opening it together with the .mml, dropping it on the window, converting a song to
;         MML, or applying a change in the DPCM definition editor puts it into the browser's
;         store, and it comes back when you reopen an MML that refers to the same name. A name
;         that is not in the store is a compile warning (and that note stays silent)
;       * "Write the .dmc files into the same folder" after saving lays them out exactly the way
;         ppmckc expects
;       * Double-click a definition line to open the DPCM definition editor (converting WAV and
;         friends to .dmc, the rate, splitting, and auditioning)
;     * kick.dmc / snare.dmc / bass.dmc below are not part of this text, so unless they are in
;     the store you will get a warning and silence ---
@DPCM0 = { "kick.dmc", 15, 0, 255, 0 }
@DPCM1 = { "snare.dmc", 15, 0, 255, 0 }
@DPCM2 = { "bass.dmc", 12, 0, 255, 1 }
@DPCM3 = { "bass.dmc", 9, 0, 255, 1 }

;@help n<num>(DPCM) :: A DPCM note is a sample number, not a pitch :: Expansion chips
; A note on the E channel is the number of the @DPCM<n> to play, not a pitch (as in ppmck).
;   n<num> ... the number itself (n0 = @DPCM0 ... n63). This is the straightforward way to write it
;   c d e ... ppmckc does not apply the octave correction on the E track, so a note name becomes
;              "octave x 16 + the semitone number": o0 c=0 ... o0 b=11, o1 c=16, o2 c=32 (the gaps
;              such as 12-15 cannot be written as note names). K cannot be used
;   The rate is fixed by the freq of the definition. To play the same sound at another pitch,
;   make a second definition with a different freq (if it is the same file, as with @DPCM2 and
;   @DPCM3 above, the ROM is shared)
;   @<n>, v, @v, @vr, D, EP, EN, MP, K and SD are errors on E (as in ppmckc). The volume is the
;   amplitude itself (baked in by "conversion volume" in the DPCM definition editor)
;   dac ... writing anything other than 0 slightly lowers the volume of the triangle and the
;         noise on real hardware (ppmck's documentation says so too, and this tool's mixer does
;         the same). Use 255 (do not write) if it bothers you
;   A rest, q or k does not stop it: it plays to the end (the ppmck default; #DPCM-RESTSTOP is
;   not supported and is an error). To stop it early, or to break out of a loop (mode=1), write
;   y$4015,$0f (the next note starts it again automatically)
E t100 l8 n0 n1 n0 n0 n1 r n0 n1
E l4 n2 y$4015,$0f r n3 y$4015,$0f r o0 c8 c+8 c8 c+8

;@help DPCM-split :: Samples over 4081 bytes, and over 16KB in total :: Techniques :: nodemo
; One definition holds at most 4081 bytes (the limit of $4013 on hardware; about one second at
; 33.1kHz - lowering the rate buys length at the cost of quality).
; A longer sound is split across several definitions and played back to back with frame-accurate
; lengths, so there is no gap at the seams:
;   @DPCM4 = { "voice_1.dmc", 15, 0, 255, 0 }   @DPCM5 = { "voice_2.dmc", 15, 0, 255, 0 } ...
;   E n4,8 n5,8 ...  (write the length of each piece without rounding; @t<len>,<num> lets you set
;                     the frame count of a note directly)
; "Split at the limit" in the DPCM definition editor, and converting a song to MML with "do not
; round the length of split DPCM", both do this for you.
; There may be 64 definitions in total (as in ppmck). Once the samples add up to more than 16KB,
; this tool switches pages through $5FFC-$5FFF on every hit (the equivalent of ppmck's automatic
; bank switching). It maps straight onto the size of a real ROM, so lower the rate, trim the
; length, or reuse the same sound
; ================================================================
;  F: FDS (custom waveform + pitch modulation)
; ================================================================
F [r1]51 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @FM<n> :: FDS wave memory :: Expansion chips
; --- FDS custom waveform @FM<n> = { 64 amplitudes (0-63) } (it may span several lines).
;                       Double-click the definition to open the editor ---
@FM0 = { 0 2 4 6 8 10 12 14 16 18 20 22 24 26 29 30 32 34 36 38 40 42 44 46 48 50 52 54 56 58 60 62
        63 61 59 57 55 53 51 49 47 45 43 41 39 37 35 33 31 29 27 25 23 21 19 17 15 13 11 9 7 5 3 1 }

; @<n> selects the custom waveform (i.e. which @FM<n>); changing the number mid-song reloads it
; automatically.
; FDS volume is v0-63 (effectively clipped at 32). v24 is roughly the old v12
F t100 l1 o5 v24 @0 c1 e1 g1
;@help @MW<n> @MH<n> MH<n> MHOF :: FDS pitch modulation :: Expansion chips
; --- The FDS pitch modulation table @MW<n> = { 32 relative increments } and its parameters
;     @MH<n> = { delay, freq, depth, waveform (the number of the @MW<n>) } ---
;     The table holds the increments added to the modulation counter (-64 to 63, wrapping on
;     overflow) once per table step (the hardware applies each entry twice).
;     Only eight values may be written - 0 (hold) / 1 / 2 / 4 / -1 / -2 / -4 / R (reset the
;     counter to 0) - and anything else is a compile error, because the hardware modulation
;     table can only express those eight steps.
;                       Double-click the table to open the editor ---
@MW0 = {
  R, -4, -2, -1, -1, -1, -2, -4, R, 4, 2, 1, 1, 1, 2, 4,
  R, -4, -2, -1, -1, -1, -2, -4, R, 4, 2, 1, 1, 1, 2, 4
}
@MH0 = { 0, 150, 15, 0 }
; Extension: with six values, @MH<n> = { delay, freq, depth, waveform, envDir, envSpeed }, the depth
;     is driven by the FDS hardware envelope. envDir is 1 = increase / -1 = decrease (0 or omitted =
;     none) and envSpeed is 0-63 (larger is slower; 63 is about one step per 4 frames). depth becomes
;     the starting depth; increase stops at 32 and decrease at 0.
;     Example: @MH1 = { 0, 128, 1, 0, 1, 63 } ... starts at depth 1 and slowly deepens

; MH<n> / MHOF: turns pitch modulation on and off, using the table defined with @MW and @MH
F MH0 c2 e2 MHOF c1

; ================================================================
;  G-L: VRC7 (FM 6ch) - custom tones and the tones in ROM
; ================================================================
GHIJKL [r1]57 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @OT<n> @OP<n> OP<n> OPOF :: VRC7 custom tone :: Expansion chips
; --- A VRC7 custom tone. @OT<n> is the readable, MGSDRV-compatible form:
;     { TL,FB, [modulator] AR,DR,SL,RR,KL,ML,AM,VB,EG,KR,DT, [carrier] the same 11 }
;     (to write the raw 8-byte form instead, use @OP<n> = { $XX,$XX,... eight of them }).
;     Double-click the definition to open the FM tone editor, where you can edit it while
;     watching the two-operator diagram, the waveform and the envelope, and where the built-in
;     tones can be loaded and auditioned ---
@OT0 = {
; TL FB
  20, 0,
; AR DR SL RR KL ML AM VB EG KR DT
  15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0,
  15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0
}

; OP<n> / OPOF: reloads @OT<n> / @OP<n> into the custom tone slot right where it appears.
; The tone selection itself stays at @0, which points at the custom slot by default.
; As on every other chip, v15 is the loudest and v0 the quietest (the hardware register holds an
; attenuation, where 0 is loudest, so the compiler writes 15-v; ppmck uses the same direction).
; @v and @vr work too (v15 is the maximum in their tables as well)
G t100 l2 o4 v3 @0 OP0
G c1 e1 g1 OPOF
;@help @<n>(VRC7) :: VRC7 tones in ROM :: Expansion chips
; The preset tones in ROM are selected directly with @<n> (1-15); no OP needed
H t100 l2 o4 v5 @1
H e1 g1 c1
I t100 l2 o4 v5 @2
I g1 c1 e1
; The remaining three channels layer a chord pad
J t100 l1 o3 v7 @3 c1 c1 c1
K t100 l1 o3 v7 @3 e1 e1 e1
L t100 l1 o3 v7 @3 g1 g1 g1

; ================================================================
;  M-O: VRC6 (3ch) - two pulses with switchable duty, and a sawtooth
; ================================================================
MNO [r1]62 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @<n>(VRC6) :: VRC6 duty :: Expansion chips
; The duty ratio of a VRC6 pulse is switched with @<n> (0-7)
M t100 l4 o4 v12 @0 c8c8c8c8 @4 c8c8c8c8 @0 c1
N t100 l4 o4 v10 @2 e8e8e8e8 @6 e8e8e8e8 @2 e1
; The sawtooth has no duty (do not write @)
; Its volume is v0-63, but v42 is the real maximum (v43 and above only overflow and break up the
; waveform without getting louder)
O t100 l32 o3 v42 g v43 g v44 g v45 g v46 g v47 g v48 g v49 g v50 g v51 g
O t100 l32 o3 v52 g v53 g v54 g v55 g v56 g v57 g v58 g v59 g v60 g v61 g v62 g v63 g
O t100 l32 o3 v42 g v53 g v44 g v55 g v46 g v57 g v48 g v59 g v40 g v61 g v42 g v63 g

; ================================================================
;  P-W: N163 (8ch) - a chord pad on custom waveforms
; ================================================================
PQRSTUVW [r1]65 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @N<n> :: N163 custom waveform :: Expansion chips
; --- N163 custom waveform @N<n> = { buffer number, wave values... }
;     * Wave values are 0-15 (4 bits). However many you list is the wave length.
;     * The length runs from 4 samples up to whatever is free in the wave RAM (128 samples at
;       8ch, 240 at 1ch; going over is a compile error). A count that is not a multiple of 4 is
;       rounded up to one (padded with zeros), because the hardware register can only express
;       the length in units of 4 samples.
;       (ppmck allows 4 to 32 samples; 33 and above is an extension of this tool.)
;     * In ppmck the leading number is a "buffer number" (0-31): the composer picked where in
;       RAM the waveform went and had to make sure waveforms of different lengths did not
;       overlap. This tool places them automatically (waveforms that never overlap in time
;       reuse the same area), so the number is read and discarded. The slot is kept for
;       syntax compatibility, so leaving it at 0 is fine.
;     * The waveform area in the N163 internal RAM is 128 - 8 x active channels bytes (64 bytes,
;       i.e. 128 samples, in this sample because it uses 8ch) and is shared by every channel
;       (2 samples per byte). If the waveforms sounding at the same time add up to more than
;       that, it is a compile error. Conversely, waveforms that never overlap in time reuse the
;       same area. Fewer channels means more room (see "N163" above).
;     * A longer waveform is smoother and can carry finer harmonics, but eats more RAM.
;     * On the note side it is selected with @<n> (write @1 to play @N1). Double-click the
;       definition for the editor ---
@N0 = { 0, 0,0,0,0,0,0,0,0,15,15,15,15,15,15,15,15 }     ; 16 samples (8 bytes), a square
@N1 = { 0, 8,10,12,14,15,15,14,12,10,8,5,3,1,0,0,1,3,5 } ; 18 rounded up to 20 (zero-padded)
@N2 = { 0, 0,0,15,15 }                                   ; the shortest, 4 samples (2 bytes), a coarse square
@N3 = { 0, 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,        ; 32 samples (16 bytes), a sawtooth
           15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0 }       ; (it may be split across two lines)

; N163 also selects its custom waveform (@N<n>) with @<n>, the same way FDS does.
; Here four different lengths sound at once (@0 = 16, @1 = 20, @2 = 4, @3 = 32 samples).
; They add up to 8+10+2+16 = 36 bytes, which fits in the 64 bytes of internal RAM.
P t100 l1 o3 v6 @0 c1 c1
Q t100 l1 o3 v6 @1 e1 e1
R t100 l1 o3 v6 @3 g1 g1
S t100 l1 o4 v5 @0 c1 c1
T t100 l1 o4 v5 @1 e1 e1
U t100 l1 o4 v5 @3 g1 g1
V t100 l1 o5 v4 @2 c1 c1
W t100 l1 o5 v4 @2 g1 g1

;@help SA<n> :: N163 pitch shift amount :: Pitch
; SA<n> (0-8): shifts the values of D, EP and MP left <n> times (x 2^n) before they are added to
;   the frequency value (official ppmckc, for N163 channels only). EP and MP table values are
;   signed bytes (+/-127) while the N163 frequency register is 18 bits, so a deep vibrato high up
;   cannot be expressed without the shift (SA0, no shift, is the default).
;   Converting a song to MML inserts it automatically according to "Pitch precision (SA)" in the
;   conversion settings.
Q SA4 EP0 o5 c2 SA0 EPOF c2

; ================================================================
;  X-Z: SUNSOFT 5B (3ch) - mixer, hardware envelope, noise
; ================================================================
XYZ [r1]70 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help @<n>(SUNSOFT 5B) S<n> M<n> N<n> :: SUNSOFT 5B mixer / hardware envelope / noise :: Expansion chips
; @<n>: the mixer (0 = mute, 1 = tone, 2 = noise, 3 = tone + noise; the ppmck convention)
; S<n>: envelope shape (0-15)  M<n>: envelope period (0-65535)  N<n>: noise frequency (0-31)
X t100 l1 o4 v12 @1 c1
X @3 S8 M200 N10 c1
X @1 c1
Y t100 l1 o4 v10 @1 e1 e1 e1
Z t100 l1 o4 v10 @1 g1 g1 g1

; ================================================================
;  a-b: MMC5 (2ch) - two pulses, and a demo of reusing the macro "$z"
; ================================================================
ab [r1]75 ; <- waits its turn (generated by tools/headless/sample-sequence.js)
;@help $<char> :: Macro :: Basics
; --- Macro definition "$<one character> <MML>" (expanded once, not recursively, and usable from
;     any channel).
;     * The macro character is substituted wherever that single raw character appears in the
;     body, so pick one that does not collide with a note, a rest or an existing command (an
;     unused letter such as "z"). ---
$z c8d8e8g8

; The "$z" (= c8d8e8g8) defined just above, reused as-is on two channels
a t100 l4 o4 v12 @0 z z c4d4e4g4
b t100 l4 o4 v9 @0 K12 z z c4d4e4g4
`;
})(window);
