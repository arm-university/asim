# ASim

ASim is browser-based tool for assembling and simulating Arm A64
assembly language programs.  ASim implements a useful subset of the
A64 opcodes; see OPCODES.md for list of supported opcodes and
operands.

To run a demo:

* clone this repo and make the top level of the repo your current
  working directory.

* `make server` to start a local server (requires python3)

* Browse to `http://localhost:8000/asim.html`.  This loads a webpage
that makes an instance of the ASim tool then loads an example assembly
language program.

* Click `Assemble`.  This will open the simulation pane to the right
of the editor pane.  The simulation pane has execution controls at the
top and several subpanes showing the state of the simulated processor.
You can click and drag the vertical divider between the editor and
simulation panes to adjust the layout.

  - `Reset` to reset the simulation to its initial state
  - `Step` to execute the next (highlighted)instruction.  The state
     displays are updated to reflect any changes made by the executed
     instruction.  Reads and writes are indicated by highlighting the
     appropriate register and/or memory location.
  - `Walk` to execute many steps sequential, with a state update
     after each step.  You can click "Stop" to stop a running simulation.
     The simulation will also halt when it reaches a HLT or BRK instruction,
     or when the simulator detects that the PC hasn't changed after executing
     an instruction (i.e., an instruction like "b ." that branches to itself).
  - `Run` like `Walk` but don't update state display after each instruction.
     This is *much* faster with simulation rates of 10 MIPS or more on my
     relatively new iMac.
