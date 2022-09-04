/*
Copyright 2022 Christopher J. Terman

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

"use strict";

//////////////////////////////////////////////////
// ARMV8-A assembly/simulation
//////////////////////////////////////////////////

SimTool.ARMV8ATool = class extends(SimTool.CPUTool) {
    constructor(tool_div) {
        // super() will call this.emulation_initialize()
        super(tool_div, 'armv8a_tool.1', 'ARMV8A', 'ARMV8A-A64');
    }

    //////////////////////////////////////////////////
    // ISA emulation
    //////////////////////////////////////////////////

    va_to_phys(va) {
        // no MMU (yet)
        return Number(va);
    }

    // provide RISC-V-specific information
    emulation_initialize() {
        // things CPUTool needs to know about our ISA
        this.line_comment = '//';
        this.block_comment_start = '/*';
        this.block_comment_end = '*/';
        this.little_endian = true;

        this.register_nbits = 64;  // 64-bit registers
        this.inst_nbits = 32;      // size of instruction in bits (multiple of 8)
        this.word_nbits = 32;      // size of memory word in bits (multiple of 8)

        // addresses are always byte addresses; addresses are Numbers
        this.data_section_alignment = 256;
        this.bss_section_alignment = 8;
        this.address_space_alignment = 256;

        this.stack_direction = 'down';   // can be 'down', 'up', or undefined
        this.sp_register_number = 31;

        // ISA-specific tables and storage
        this.pc = 0n;
        this.register_file = new Array(32 + 1);    // include extra reg for writes to xzr
        this.memory = new DataView(new ArrayBuffer(256));  // assembly will replace this

        this.register_info();
        this.opcode_info();
        this.opcode_handlers();

        // reset to initial state
        this.emulation_reset();
    }

    // reset emulation state to initial values
    emulation_reset() {
        this.pc = 0n;
        this.register_file.fill(0n);

        if (this.assembler_memory !== undefined) {
            // allocate working copy of memory if needed
            if (this.memory === undefined || this.memory.byteLength != this.assembler_memory.byteLength) {
                this.memory = new DataView(new ArrayBuffer(this.assembler_memory.byteLength));
                this.inst_decode = Array(this.memory.byteLength/4);  // holds decoded inst objs
            }

            // initialize memory by copying contents from assembler_memory
            new Uint8Array(this.memory.buffer).set(new Uint8Array(this.assembler_memory.buffer));
        }
    }

    // execute a single instruction
    emulation_step(update_display) {
        if (update_display) this.clear_highlights();

        // have we already decoded the instruction?
        let info = this.inst_decode[this.pc / 4];

        // if not, do it now...
        if (info === undefined) {
            const inst = this.memory.getUint32(this.pc,true);
            this.disassemble(inst, this.pc);   // fills in inst_decode
            info = this.inst_decode[this.pc/4];
            if (info === undefined) {
                throw 'Cannot decode instruction at ' + this.pc;
            }
        }

        // handler function will emulate instruction
        // if gui is passed, handler will call the appropriate gui update functions
        info.handler(info, update_display);

        // update PC and disassembly displays
        if (update_display) this.next_pc(this.pc);
    }

    emulation_pc() {
        return this.pc;
    }

    //////////////////////////////////////////////////
    // ISA registers
    //////////////////////////////////////////////////

    // set up this.registers, this.register_names
    register_info() {
        // map token (register name) => register number
        this.registers = new Map();
        for (let i = 0; i <= 30; i += 1) {
            this.registers.set('x'+i, i);
            this.registers.set('w'+i, i);
        }

        this.registers.set('xzr', 31);
        this.registers.set('sp', 28);
        this.registers.set('fp', 29);
        this.registers.set('lr', 30);

        this.register_names = this.registers;
    }

    //////////////////////////////////////////////////
    // ISA opcodes
    //////////////////////////////////////////////////

    /*
      ADD    (o = 0, S = 0)
      ADDS   (o = 0, S = 1)   [CMN]
      SUB    (o = 1, S = 0))
      SUBS   (o = 1, S = 1)   [CMP, NEGS]
        "zoS01011001mmmmmoooiiinnnnnnnnnn"   extended register (SP)
        "zoS01011ss0mmmmmiiiiiinnnnnddddd"   shifted registers (LSL,LSR,ASR,RSVD)
        "zoS100010siiiiiiiiiiiinnnnnddddd"   immediate (unsigned, <<12, SP)

      ADC  (o = 0, S = 0)
      ADCS (o = 0, S = 1)
      SBC  (o = 1, S = 0)   [NGC]
      SBCS (o = 1, S = 1)   [NGCS]
        "zoS11010000mmmmm000000nnnnnddddd"
        "zo011010000mmmmm000000nnnnnddddd"

      AND    (oo = 00, N = 0)
      ANDS   (oo = 11, N = 0)   [TST]
      BIC    (oo = 00, N = 1)
      BICS   (oo = 11, N = 1)
      EON    (oo = 10, N = 1)
      EOR    (oo = 10, N = 0)
      ORR    (oo = 01, N = 0)   [MOV]
      ORN    (oo = 01, N = 1)   [MOVN]
        "zoo01010ss0mmmmmiiiiiinnnnnddddd"   shifted register (LSL,LSR,ASR,ROR)
        "zoo100100Nrrrrrrssssssnnnnnddddd"   immediate

      ADR
      ADRP
        "Pii10000IIIIIIIIIIIIIIIIIIIddddd"   imm = I<<2 | i

      MADD (o = 0)   [MUL]
      MSUB (o = 1)   [MNEG]
        "z0011011000mmmmmoaaaaannnnnddddd"

      SDIV (o = 1)
      UDIV (o = 0)
        "z0011010110mmmmm00001onnnnnddddd"

      SMADDL (o = 0, U = 0)   [SMULL]
      SMSUBL (o = 1, U = 0)   [SMNEGL]
      UMADDL (o = 0, U = 1)
      UMSUBL (o = 1, U = 1)
        "10011011U01mmmmmoaaaaannnnnddddd"

      LSLV (reg, oo = 00)      [LSL]
      LSRV (reg, oo = 01)      [LSR]
      ASRV (reg, oo = 10)      [ASR]
      RORV (reg, oo = 11)      [ROR]
        "z0011010110mmmmm0010oonnnnnddddd"

      MOVK (o = 11)
      MOVN (o = 00)    [MOV]
      MOVZ (o = 10)    [MOV]
        "zoo100101hhiiiiiiiiiiiiiiiiddddd"     imm = i << (h << 4)

      SBFM (o = 00)   [ASR, SBFIZ, SBFX, SXTB, SXTH, SXTW]
      BFM  (o = 01)   [BFC, BFI, BFXIL]
      UBFM (o = 10)   [LSL, LSR, UBFIZ, UBFX, UXTB, UXTH]
        "zoo100110Nrrrrrrssssssnnnnnddddd"
        "zoo100110Nrrrrrrssssssnnnnnddddd"

      CLS (x=1)
      CLZ (x=0)
        "z10110101100000000010xnnnnnddddd"

      EXTR (nb: z == N)   [ROR]
        "z00100111N0mmmmmiiiiiinnnnnddddd"

      RBIT
        "z101101011000000000000nnnnnddddd"

      REV (o = 1x)    [REV64]
      REV16 (o = 01)
      REV32 (o = 10)
      REV64 (o = 11)
        "z1011010110000000000oonnnnnddddd"
      SBFM (o = 00)   [ASR, SBFIZ, SBFX, SXTB, SXTH, SXTW]
        "z00100110Nrrrrrrssssssnnnnnddddd"

      B  (L = 0)
      BL (L = 1)
        "L00101IIIIIIIIIIIIIIIIIIIIIIIIII"

      BEQ (c = 0, Z)
      BNE (c = 1, !Z)
      BCS/BHS (c = 2, C)
      BCC/BLO (c = 3, !C)
      BMI (c = 4, N)
      BPL (c = 5, !N)
      BVS (c = 6, V)
      BVC (c = 7, !V)
      BHI (c = 8, C & !Z)
      BLS (c = 9, !C | Z)
      BGE (c = 10, N = V)
      BLT (c = 11, N != V)
      BGT (c = 12, !Z & N=V)
      BLT (c = 13, Z | N!=V)
      BAL (c = 14/15, --)
        "01010100IIIIIIIIIIIIIIIIIII0cccc"

      BLR
        "1101011000111111000000nnnnnddddd"

      BR
        "1101011000011111000000nnnnn00000"

      CBNZ (x=1)
      CBZ  (x=0)
        "z011010xIIIIIIIIIIIIIIIIIIIttttt"

      RET
        "1101011001011111000000nnnnnmmmmm"

      TBZ (o = 0)
      TBNZ (o = 1)
        "c011011obbbbbIIIIIIIIIIIIIIttttt"   bit_pos = {c,b}

      LDP (o = 0, L = 1)  (Xt, Xu)
      LDPSW (o = 1, L = 1)
      STP (o = 0, L = 0)  
        ".o1010001Liiiiiiiuuuuunnnnnttttt"   post-index
        ".o1010011Liiiiiiiuuuuunnnnnttttt"   pre-index
        ".o1010010Liiiiiiiuuuuunnnnnttttt"   signed-offset

      LDR (xx = 1z, oo = 01)
      LDUR (xx = 1z, oo = 01)
      LDRSW (xx = 10, oo = 10)
      LDURSW (xx = 10, oo = 10)
      STR (xx = 1z, oo = 00)
        "xx111000oo0IIIIIIIII00nnnnnttttt"   LDUR...
        "xx111000oo0IIIIIIIII01nnnnnttttt"   post-index
        "xx111000oo0IIIIIIIII11nnnnnttttt"   pre-index
        "xx111001ooIIIIIIIIIIIInnnnnttttt"   unsigned-offset
        "xx011000IIIIIIIIIIIIIIIIIIIttttt"   pc-relative
        "xx111000oo1mmmmmsssS10nnnnnttttt"   register (s=010:UXTW,011:LSL,110:SXTW,111:SXTX)

      LDRB (xx = 00, oo = 01)
      LDURB (xx = 00, oo = 01)
      LDRSB (xx = 00, oo = 10)
      LDURSB (xx = 00, oo = 10)
      LDRH (xx = 01, oo = 01)
      LDURH (xx = 00, oo = 01)
      LDRSH (xx = 01, oo = 10)
      LDURSH (xx = 01, oo = 10)
      STRB,STURB (xx = 00, oo = 00)
      STRH, STURH (xx = 01, oo = 00)
        "xx111000oo0IIIIIIIII00nnnnnttttt"   LDUR..., STUR...
        "xx111000oo0IIIIIIIII01nnnnnttttt"   post-index
        "xx111000oo0IIIIIIIII11nnnnnttttt"   pre-index
        "xx111001ooIIIIIIIIIIIInnnnnttttt"   unsigned-offset
        "xx111000oo1mmmmmsssS10nnnnnttttt"   extended register (s=010:UXTW,110:SXTW,111:SXTX)
        "xx111000oo1mmmmmsssS10nnnnnttttt"   shifted register (s = 011)
    */

    opcode_info() {
        // format chars:
        //   r: Xn or Wn (consistently, implies z field in pattern)
        //   x: Xn
        //   w: Wn
        //   i: #i
        //   I: #i{, sh}
        //   J: #i{, LSL 0,16,32,48}  (implies j,s fields)
        //   F: #i (value = -imm mod 32/64)
        //   G: #i (value = imm - 1)
        //   H: #i (value = F + imm - 1
        //   P: pc-relative offset (bottom two bits = 0)
        //   Q: pc-relative offset (implies I=imm[20:2], i=imm[1:0] fields)
        //   e: extended register (implies m, o, i fields)
        //   s: shifted register (implies s,m,i fields)
        //   t: immediate (optionally shifted by 12) (implies s,i fields)
        //   -: -immediate (implies r=-imm, s=31-imm) fields
        //   m: encoding for bit mask (implies N,r,s fields)
        //   b: bit number (implies c,b fields)
        // order of list matters!  some masks are more specific than subsequent masks...

        // [operand formats, field names, instruction pattern]
        this.opcodes = {
            add:    [['rre',  'dne',  'z0001011001mmmmmoooiiinnnnnddddd'],
                     ['rrs',  'dns',  'z0001011ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrt',  'dnt',  'z00100010siiiiiiiiiiiinnnnnddddd']],
            cmn:    [['rre',  'dne',  'z0101011001mmmmmoooiiinnnnn11111'],  // alias: ADDS
                     ['rrs',  'dns',  'z0101011ss0mmmmmiiiiiinnnnn11111'],
                     ['rrt',  'dnt',  'z01100010siiiiiiiiiiiinnnnn11111']],
            adds:   [['rre',  'dne',  'z0101011001mmmmmoooiiinnnnnddddd'],
                     ['rrs',  'dns',  'z0101011ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrt',  'dnt',  'z01100010siiiiiiiiiiiinnnnnddddd']],
            neg:    [['rs',   'ds',   'z1001011ss0mmmmmiiiiii11111ddddd']], // alias: SUB
            sub:    [['rre',  'dne',  'z1001011001mmmmmoooiiinnnnnddddd'],
                     ['rrs',  'dns',  'z1001011ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrt',  'dnt',  'z10100010siiiiiiiiiiiinnnnnddddd']],
            cmp:    [['rre',  'dne',  'z1101011001mmmmmoooiiinnnnn11111'],  // alias: SUBS
                     ['rrs',  'dns',  'z1101011ss0mmmmmiiiiiinnnnn11111'],
                     ['rrt',  'dnt',  'z11100010siiiiiiiiiiiinnnnn11111']],
            negs:   [['rs',   'ds',   'z1101011ss0mmmmmiiiiiinnnnnddddd']], // alias: SUBS
            subs:   [['rre',  'dne',  'z1101011001mmmmmoooiiinnnnnddddd'],
                     ['rrs',  'dns',  'z1101011ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrt',  'dnt',  'z11100010siiiiiiiiiiiinnnnnddddd']],

            adr:    [['xQ',   'd-',   '0ii10000IIIIIIIIIIIIIIIIIIIddddd']],
            adrp:   [['xQ',   'd-',   '1ii10000IIIIIIIIIIIIIIIIIIIddddd']],

            mul:    [['rrr',  'dnm',  'z0011011000mmmmm011111nnnnnddddd']], // alias: MADD
            mneg:   [['rrrr', 'dnma', 'z0011011000mmmmm111111nnnnnddddd']], // alias: MSUB
            madd:   [['rrrr', 'dnma', 'z0011011000mmmmm0aaaaannnnnddddd']],
            msub:   [['rrrr', 'dnma', 'z0011011000mmmmm1aaaaannnnnddddd']],

            adc:    [['rrr',  'dnm',  'z0011010000mmmmm000000nnnnnddddd']],
            adcs:   [['rrr',  'dnm',  'z0111010000mmmmm000000nnnnnddddd']],
            ngc:    [['rr',   'dm',   'z1011010000mmmmm00000011111ddddd']], // alias: SBC
            ngcs:   [['rr',   'dm',   'z1111010000mmmmm00000011111ddddd']], // alias: SBCS
            sbc:    [['rrr',  'dnm',  'z1011010000mmmmm000000nnnnnddddd']],
            sbcs:   [['rrr',  'dnm',  'z1111010000mmmmm000000nnnnnddddd']],

            sdiv:   [['rrr',  'dnm',  'z0011010110mmmmm000011nnnnnddddd']],
            udiv:   [['rrr',  'dnm',  'z0011010110mmmmm000010nnnnnddddd']],

            smull:  [['xww',  'dnm',  '10011011001mmmmm011111nnnnnddddd']], // alias: SMADDL
            umull:  [['xww',  'dnm',  '10011011101mmmmm011111nnnnnddddd']], // alias: UMADDL
            smaddl: [['xwwx', 'dnma', '10011011001mmmmm0aaaaannnnnddddd']],
            umaddl: [['xwwx', 'dnma', '10011011101mmmmm0aaaaannnnnddddd']],
            smnegl: [['xww',  'dnma', '10011011001mmmmm111111nnnnnddddd']], // alias: SMSUBL
            umnegl: [['xww',  'dnma', '10011011101mmmmm111111nnnnnddddd']], // alias: UMSUBl
            smsubl: [['xwwx', 'dnma', '10011011001mmmmm1aaaaannnnnddddd']],
            umsubl: [['xwwx', 'dnma', '10011011101mmmmm1aaaaannnnnddddd']],
            smulh:  [['xxx',  'dnm',  '10011011010mmmmm011111nnnnnddddd']],
            umulh:  [['xxx',  'dnm',  '10011011110mmmmm011111nnnnnddddd']],

            bfc:    [['rFG',  'drs',  'z01100110zrrrrrrssssss11111ddddd']], // alias: BFM
            bfi:    [['rrFG', 'dnrs', 'z01100110zrrrrrrssssssnnnnnddddd']], // alias: BFM
            bfxil:  [['rrrH', 'dnrs', 'z01100110zrrrrrrssssssnnnnnddddd']], // alias: BFM
            bfm:    [['rrii', 'dnrs', 'z01100110zrrrrrrssssssnnnnnddddd']],

            asr:    [['rrr',  'dnm',  'z0011010110mmmmm001010nnnnnddddd'],
                     ['rri',  'dni',  'z00100110ziiiiiiz11111nnnnnddddd']], // alias: SBFM
            lsl:    [['rrr',  'dnm',  'z0011010110mmmmm001000nnnnnddddd'],
                     ['rri',  'dn-',  'z10100110zrrrrrrssssssnnnnnddddd']], // alias: UBFM
            lsr:    [['rrr',  'dnm',  'z0011010110mmmmm001001nnnnnddddd'],
                     ['rri',  'dni',  'z10100110ziiiiiiz11111nnnnnddddd']], // alias: UBFM
            ror:    [['rrr',  'dnm',  'z0011010110mmmmm001011nnnnnddddd'],
                     ['rri',  'dsi',  'z00100111z0sssssiiiiiisssssddddd']], // alias: EXTR

            sxtb:   [['rr',   'dn',   'z00100110z000000000111nnnnnddddd']], // alias: SBFM
            sxth:   [['rr',   'dn',   'z00100110z000000001111nnnnnddddd']], // alias: SBFM
            sxtw:   [['rr',   'dn',   'z00100110z000000011111nnnnnddddd']], // alias: SBFM
            sbfm:   [['rrii', 'dnrs', 'z00100110zrrrrrrssssssnnnnnddddd']],
       
            uxtb:   [['wwii', 'dn',   '0101001100000000000111nnnnnddddd']], // alias: UBFM
            uxth:   [['wwii', 'dn',   '0101001100000000001111nnnnnddddd']], // alias: UBFM
            ubfm:   [['rrii', 'dnrs', 'z10100110zrrrrrrssssssnnnnnddddd']],

            cls:    [['rr',   'dn',   'z101101011000000000101nnnnnddddd']],
            clz:    [['rr',   'dn',   'z101101011000000000100nnnnnddddd']],

            rbit:   [['rr' ]],
            rev:    [['rr' ]],
            rev16:  [['rr' ]],
            rev32:  [['xx' ]],

            mov:    [['rm',   'dm',   'z01100100Nrrrrrrssssss11111ddddd']],  // alias: AND(imm)

            and:    [['rrs',  'dns',  'z0001010ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrm',  'dnm',  'z00100100Nrrrrrrssssssnnnnnddddd']],
            tst:    [['rs',   'ns',   'z1101010ss0mmmmmiiiiiinnnnn11111'],   // alias: ANDS
                     ['rm',   'dn',   'z11100100Nrrrrrrssssssnnnnn11111']],
            ands:   [['rrs',  'dns',  'z1101010ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrm',  'dnm',  'z11100100Nrrrrrrssssssnnnnnddddd']],
            orr:    [['rrs',  'dns',  'z0101010ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrm',  'dnm',  'z01100100Nrrrrrrssssssnnnnnddddd']],
            eor:    [['rrs',  'dns',  'z1001010ss0mmmmmiiiiiinnnnnddddd'],
                     ['rrm',  'dnm',  'z10100100Nrrrrrrssssssnnnnnddddd']],

            orn:    [['rrs',  'dns',  'z0101010ss1mmmmmiiiiiinnnnnddddd']],
            bic:    [['rrs',  'dns',  'z0001010ss1mmmmmiiiiiinnnnnddddd']],
            bics:   [['rrs',  'dns',  'z1101010ss1mmmmmiiiiiinnnnnddddd']],
            eon:    [['rrs',  'dns',  'z1001010ss1mmmmmiiiiiinnnnnddddd']],

            ror:    [['rri',  'dns',  'z00100111z0nnnnnssssssnnnnnddddd'],   // alias: EXTR
                     ['rrr',  'dnm',  'z0011010110mmmmm001011nnnnnddddd']],
            extr:   [['rrri', 'dnms', 'z00100111z0mmmmmssssssnnnnnddddd']],

            movn:   [['rJ',   'd-',   'z00100101ssjjjjjjjjjjjjjjjjddddd']],
            movz:   [['rJ',   'd-',   'z10100101ssjjjjjjjjjjjjjjjjddddd']],
            movk:   [['rJ',   'd-',   'z11100101ssjjjjjjjjjjjjjjjjddddd']],

            beq:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00000']],
            bne:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00001']],
            bcs:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00010']],
            bhs:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00010']],
            bcc:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00011']],
            blo:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00011']],
            bmi:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00100']],
            bpl:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00101']],
            bvs:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00110']],
            bvc:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII00111']],
            bhi:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01000']],
            bls:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01001']],
            bge:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01010']],
            blt:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01011']],
            bgt:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01100']],
            ble:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01101']],
            bal:    [['P',    'I',    '01010100IIIIIIIIIIIIIIIIIII01111']],

            b:      [['P',    'I',    '000101IIIIIIIIIIIIIIIIIIIIIIIIII']],
            bl:     [['P',    'I',    '100101IIIIIIIIIIIIIIIIIIIIIIIIII']],

            br:     [['x',    'n',    '1101011000011111000000nnnnn00000']],
            blr:    [['x',    'n',    '1101011000111111000000nnnnn00000']],
            ret:    [['',     '',     '11010110010111110000001111000000'],
                     ['x',    'n',    '1101011001011111000000nnnnn00000']],
            cbz:    [['rP',   'tI'    'z0110100IIIIIIIIIIIIIIIIIIIttttt']],
            cbnz:   [['rP',   'tI'    'z0110101IIIIIIIIIIIIIIIIIIIttttt']],
            tbz:    [['rbP',  'bI',   'a0110110bbbbbIIIIIIIIIIIIIIttttt']],
            tbnz:   [['rbP',  'bI',   'a0110111bbbbbIIIIIIIIIIIIIIttttt']],

            ldp:    [['rra' ]],
            ldpsw:  [['xxa' ]],
            ldr:    [['ra' ]],
            ldur:   [['ra' ]],
            ldrb:   [['wa' ]],
            ldrh:   [['wa' ]],
            ldurb:  [['wa' ]],
            ldurh:  [['wa' ]],
            ldrsb:  [['wa' ]],
            ldrsh:  [['wa' ]],
            ldursb: [['wa' ]],
            ldursh: [['wa' ]],
            ldrsw:  [['xa' ]],
            ldursw: [['xa' ]],
            stp:    [['rra' ]],
            str:    [['ra' ]],
            stur:   [['ra' ]],
            strb:   [['wa' ]],
            strh:   [['wa' ]],
            sturb:  [['wa' ]],
            sturh:  [['wa' ]],
        };
        


        // LEGv8 from H&P
        this.inst_codec = new SimTool.InstructionCodec({
            add:    {pattern: "10001011ss0mmmmmaaaaaannnnnddddd", type: "R"},
            addi:   {pattern: "1001000100IIIIIIIIIIIInnnnnddddd", type: "I"},
            addis:  {pattern: "1011000100IIIIIIIIIIIInnnnnddddd", type: "I"},
            adds:   {pattern: "10101011ss0mmmmmaaaaaannnnnddddd", type: "R"},
            and:    {pattern: "10001010000mmmmmaaaaaannnnnddddd", type: "R"},
            andi:   {pattern: "1001001000IIIIIIIIIIIInnnnnddddd", type: "I"},
            andis:  {pattern: "1111001000IIIIIIIIIIIInnnnnddddd", type: "I"},
            ands:   {pattern: "11101010ss0mmmmmaaaaaannnnnddddd", type: "R"},
            b:      {pattern: "000101IIIIIIIIIIIIIIIIIIIIIIIIII", type: "B"},

            'b.eq': {pattern: "01010100IIIIIIIIIIIIIIIIIII00000", type: "CB"},
            'b.ne': {pattern: "01010100IIIIIIIIIIIIIIIIIII00001", type: "CB"},
            'b.hs': {pattern: "01010100IIIIIIIIIIIIIIIIIII00010", type: "CB"},
            'b.lo': {pattern: "01010100IIIIIIIIIIIIIIIIIII00011", type: "CB"},
            'b.mi': {pattern: "01010100IIIIIIIIIIIIIIIIIII00100", type: "CB"},
            'b.pl': {pattern: "01010100IIIIIIIIIIIIIIIIIII00101", type: "CB"},
            'b.vs': {pattern: "01010100IIIIIIIIIIIIIIIIIII00110", type: "CB"},
            'b.vc': {pattern: "01010100IIIIIIIIIIIIIIIIIII00111", type: "CB"},
            'b.hi': {pattern: "01010100IIIIIIIIIIIIIIIIIII01000", type: "CB"},
            'b.ls': {pattern: "01010100IIIIIIIIIIIIIIIIIII01001", type: "CB"},
            'b.ge': {pattern: "01010100IIIIIIIIIIIIIIIIIII01010", type: "CB"},
            'b.lt': {pattern: "01010100IIIIIIIIIIIIIIIIIII01011", type: "CB"},
            'b.gt': {pattern: "01010100IIIIIIIIIIIIIIIIIII01100", type: "CB"},
            'b.le': {pattern: "01010100IIIIIIIIIIIIIIIIIII01101", type: "CB"},
            'b.al': {pattern: "01010100IIIIIIIIIIIIIIIIIII01110", type: "CB"},
            'b.nv': {pattern: "01010100IIIIIIIIIIIIIIIIIII01111", type: "CB"},

            bl:     {pattern: "100101IIIIIIIIIIIIIIIIIIIIIIIIII", type: "B"},
            br:     {pattern: "11010110000mmmmmaaaaaannnnnddddd", type: "R"},
            cbnz:   {pattern: "10110101IIIIIIIIIIIIIIIIIIIttttt", type: "CB"},
            cbz:    {pattern: "10110100IIIIIIIIIIIIIIIIIIIttttt", type: "CB"},
            eor:    {pattern: "11001010000mmmmmaaaaaannnnnddddd", type: "R"},
            eori:   {pattern: "1101001000IIIIIIIIIIIInnnnnddddd", type: "I"},
            //fadds:  {pattern: "00011110001mmmmm001010nnnnnddddd", type: "R"},
            //faddd:  {pattern: "00011110011mmmmm001010nnnnnddddd", type: "R"},
            //fcmps:  {pattern: "00011110001mmmmm001000nnnnnddddd", type: "R"},
            //fcmpd:  {pattern: "00011110011mmmmm001000nnnnnddddd", type: "R"},
            //fdivs:  {pattern: "00011110001mmmmm000110nnnnnddddd", type: "R"},
            //fdivd:  {pattern: "00011110011mmmmm000110nnnnnddddd", type: "R"},
            //fmuls:  {pattern: "00011110001mmmmm000010nnnnnddddd", type: "R"},
            //fmuld:  {pattern: "00011110011mmmmm000010nnnnnddddd", type: "R"},
            //fsubs:  {pattern: "00011110001mmmmm001110nnnnnddddd", type: "R"},
            //fsubd:  {pattern: "00011110011mmmmm001110nnnnnddddd", type: "R"},
            ldur:   {pattern: "11111000010IIIIIIIII00nnnnnttttt", type: "D"},
            ldurb:  {pattern: "00111000010IIIIIIIII00nnnnnttttt", type: "D"},
            //ldurd:  {pattern: "11111000010IIIIIIIII00nnnnnttttt", type: "D"},
            ldurh:  {pattern: "01111000010IIIIIIIII00nnnnnttttt", type: "D"},
            //ldurs:  {pattern: "10111100010IIIIIIIII00nnnnnttttt", type: "D"},
            ldursw: {pattern: "10111000100IIIIIIIII00nnnnnttttt", type: "D"},
            ldxr:   {pattern: "1100100001011111011111nnnnnttttt", type: "D"},
            lsl:    {pattern: "11010011011mmmmmaaaaaannnnnddddd", type: "R"},
            lsr:    {pattern: "11010011010mmmmmaaaaaannnnnddddd", type: "R"},
            movk:   {pattern: "111100101IIIIIIIIIIIIIIIIIIddddd", type: "IM"},
            movz:   {pattern: "110100101IIIIIIIIIIIIIIIIIIddddd", type: "IM"},
            mul:    {pattern: "10011011000mmmmm011111nnnnnddddd", type: "R"},
            orr:    {pattern: "10101010000mmmmmaaaaaannnnnddddd", type: "R"},
            orri:   {pattern: "1011001000IIIIIIIIIIIInnnnnddddd", type: "I"},
            sdiv:   {pattern: "10011010110mmmmm000010nnnnnddddd", type: "R"},
            smulh:  {pattern: "10011011010mmmmm011111nnnnnddddd", type: "R"},
            stur:   {pattern: "11111000000IIIIIIIII00nnnnnttttt", type: "D"},
            sturb:  {pattern: "00111000000IIIIIIIII00nnnnnttttt", type: "D"},
            //sturd : {pattern: "11111100000IIIIIIIII00nnnnnttttt", type: "D"},
            sturh:  {pattern: "01111000000IIIIIIIII00nnnnnttttt", type: "D"},
            //sturs:  {pattern: "10111100000IIIIIIIII00nnnnnttttt", type: "D"},
            sturw:  {pattern: "10111000000IIIIIIIII00nnnnnttttt", type: "D"},
            stxr:   {pattern: "11001000000IIIIIIIII00nnnnnttttt", type: "D"},
            sub:    {pattern: "11001011000mmmmmaaaaaannnnnddddd", type: "R"},
            subi:   {pattern: "1101000100IIIIIIIIIIIInnnnnddddd", type: "I"},
            subis:  {pattern: "1111000100IIIIIIIIIIIInnnnnddddd", type: "I"},
            subs:   {pattern: "11101011000mmmmmaaaaaannnnnddddd", type: "R"},
            udiv:   {pattern: "10011010110mmmmm000011nnnnnddddd", type: "R"},
            umulh:  {pattern: "10011011110mmmmm011111nnnnnddddd", type: "R"},
        });

        // define macros for official pseudo ops
        // remember to escape the backslashes in the macro body!
        this.assembly_prologue = `
`;
    }

    // return text representation of instruction at addr
    disassemble(addr) {
        const inst = this.memory.getUint32(addr,this.little_endian);

    }

    // NB: rd fields of zero are redirected to this.register_file[32]
    disassemble_opcode(v, opcode, info, addr) {
        return opcode + '???';
    }

    // define functions that assemble and emulate each opcode
    opcode_handlers() {
        const tool = this;  // for reference by handlers

        this.assembly_handlers = new Map();

        this.assembly_handers.set('add',function (operands) {
        });

        this.execution_handlers = new Map();  // execution handlers: opcode => function
    }

    //////////////////////////////////////////////////
    // Assembly
    //////////////////////////////////////////////////

    // return Array of operand objects.  Possible properties:
    //  .register:  Xn or Wn
    //  .shift:  lsl, lsr, asr, ror, [su]xt[bhwx]
    //  .shamt:  expression tree
    //  .pre_index: boolean
    //  .addr: Array of operand objects
    //  .post_index: expression tree
    //  .imm: expression tree
    parse_operands(operands) {
        let result = [];
        let index = 0;

        while (index < operands.length) {
            let operand = operands[index++];   // list of tokens
            let j = 0;

            let token = operand[j];
            let tstring = (token.type == 'number') ? '' : token.token.toLowerCase();

            // register name
            if (this.registers.has(tstring)) {
                result.push({register: tstring});
                j += 1;
                if (j < operand.length)
                    throw this.syntax_error(`Register name expected`,
                                            operand[0].start, operand[operand.length - 1].end);
            } else if (tstring.match(/lsl|lsr|asr|ror|[su]xt[bhwx]/)) {
                // op2: shifted or extended register indicators for previous register operand
                j += 1;
                if (operand[j].token == '#') j += 1;
                const prev = result[result.length - 1];
                if (prev !== undefined && prev.register !== undefined) {
                    prev.shift = tstring;
                    prev.shamt = this.read_expression(operand,j);
                } else 
                    throw this.syntax_error(`Bad register for register shift or extension`,
                                            operand[0].start, operand[operand.length - 1].end);
            } else if (tstring == '[') {
                // address operand
                let astart = j+1;
                let aend = operand.length - 1;

                // look for pre-index indicator
                let pre_index = false;
                if (operand[aend].token === '!') { pre_index = true; aend -= 1; }

                if (operand[aend].token !== ']')
                    throw this.syntax_error('Unrecognized address operand format',
                                            operand[0].start, operand[operand.length - 1].end);

                // now parse what was between [ and ]
                // by building array of comma-separated operands
                // then recursively parse that array
                let addr = [[]];  // will add additional elements if needed
                while (astart < aend) {
                    if (operand[astart].token === ',') addr.push([]);
                    else addr[addr.length - 1].push(operand[astart]);
                    astart += 1;
                }
                result.push({pre_index: pre_index,
                             addr: this.parse_operands(addr)
                            });
            } else {
                // immediate operand
                if (operand[j].token == '#') j += 1;
                const imm = this.read_expression(operand,j);

                // is this a post-index for previous address operand?
                const prev = result[result.length - 1];
                if (prev !== undefined && prev.addr !== undefined)
                   prev.post_index = imm;
                else
                    // not a post index, so it's an immediate operand
                    result.push({imm: imm});
            }
        }

        return result;
    }

    // return undefined if opcode not recognized, otherwise number of bytes
    // occupied by assembled instruction.
    // Call results.emit32(inst) to store binary into main memory at dot.
    // Call results.syntax_error(msg, start, end) to report an error
    assemble_opcode(opcode, operands) {
        operands = this.parse_operands(operands);

        

        console.log(opcode.token, operands);
        return 0;

        /*
        const info = this.opcodes.get(opcode.token.toLowerCase());

        if (info === undefined) return undefined;

        return undefined;
        */
    }

};

//////////////////////////////////////////////////
// ARMV8A syntax coloring
//////////////////////////////////////////////////

CodeMirror.defineMode('ARMV8A', function() {
    'use strict';

    const line_comment = '//';
    const block_comment_start = '/*';
    const block_comment_end = '*/';

    // consume characters until end character is found
    function nextUntilUnescaped(stream, end) {
        let escaped = false, next;
        while ((next = stream.next()) != null) {
            if (next === end && !escaped) {
                return false;
            }
            escaped = !escaped && next === "\\";
        }
        return escaped;
    }

    // consume block comment
    function clikeComment(stream, state) {
        let maybeEnd = false, ch;
        while ((ch = stream.next()) != null) {
            if (ch === "/" && maybeEnd) {
                state.tokenize = null;
                break;
            }
            maybeEnd = (ch === "*");
        }
        return "comment";
    }

    let directives = [
        '.align',
        '.ascii',
        '.asciz',
        '.bss',
        '.byte',
        '.data',
        '.dword',
        '.global',
        '.hword',
        '.include',
        '.section',
        '.text',
        '.word'
    ];

    let registers = [
        'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7',
        'x8', 'x9', 'x10', 'x11', 'x12', 'x23', 'x14', 'x15',
        'x16','x17', 'x18', 'x19', 'x20', 'x21', 'x22', 'x23',
        'x24', 'x25', 'x26', 'x27', 'x28', 'x29', 'x30', 'xzr',
        'sp', 'fp', 'lr',
    ];

    // mode object for CodeMirror
    return {
        mode_name: 'ARMV8A',
        lineComment: '//',
        blockCommentStart: '/*',
        blockCommentEnd: '*/',

        startState: function() { return { tokenize: null }; },

        // consume next token, return its CodeMirror syntax style
        token: function(stream, state) {
            if (state.tokenize) return state.tokenize(stream, state);

            if (stream.eatSpace()) return null;

            let ch = stream.next();

            // block and line comments
            if (ch === "/") {
                if (stream.eat("*")) {
                    state.tokenize = clikeComment;
                    return clikeComment(stream, state);
                }
                if (stream.eat("/")) {
                    stream.skipToEnd();
                    return "comment";
                }
            }

            // string
            if (ch === '"') {
                nextUntilUnescaped(stream, '"');
                return "string";
            }

            // directive
            if (ch === '.') {
                stream.eatWhile(/\w/);
                const cur = stream.current().toLowerCase();
                return directives.find(element => element===cur) !== undefined ? 'builtin' : null;
            }

            // symbol assignment
            if (ch === '=') {
                stream.eatWhile(/\w/);
                return "tag";
            }

            if (ch === '{') {
                return "bracket";
            }

            if (ch === '}') {
                return "bracket";
            }

            // numbers
            if (/\d/.test(ch)) {
                if (ch === "0" && stream.eat(/[xXoObB]/)) {
                    stream.eatWhile(/[0-9a-fA-F]/);
                    return "number";
                }
                if (stream.eat(/[bBfF]/)) {
                    return 'tag';
                }
                stream.eatWhile(/\d/);
                if (stream.eat(':')) {
                    return 'tag';
                }
                return "number";
            }

            // symbol
            if (/\w/.test(ch)) {
                stream.eatWhile(/\w/);
                if (stream.eat(":")) {
                    return 'tag';
                }
                const cur = stream.current().toLowerCase();
                return registers.find(element => element==cur) !== undefined ? 'keyword' : null;
            }

            return undefined;
        },
    };
});

// set up GUI in any div.armv8a_tool
window.addEventListener('load', function () {
    for (let div of document.getElementsByClassName('armv8a_tool')) {
        new SimTool.ARMV8ATool(div);
    }
});
