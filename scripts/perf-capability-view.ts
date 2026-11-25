/** Synthetic fleet capability-view build cost. */
import { canvasToCapabilityView } from "../src/shared/physics/view";
import { canvasOf, region, seat, taskBoard } from "../tests/support/model-nodes";

const make = (seats: number, boards: number) => {
  const nodes:any[] = [region("r1",{x:0,y:0,width:100000,height:100000})];
  for (let i=0;i<seats;i++) nodes.push(seat(`s${i}`,{x:10+i,y:10,width:10,height:10,host:"m",agentKey:`m:s${i}`}));
  for (let i=0;i<boards;i++) nodes.push(taskBoard(`t${i}`,{x:20+i,y:20,width:10,height:10}));
  return canvasOf(nodes,[]);
};
for (const seats of [100,300,1000]) {
  const boards=seats;
  const doc=make(seats,boards);
  for(let i=0;i<3;i++) canvasToCapabilityView(doc,{editingMachine:"m"});
  const reps:number[]=[];
  for(let i=0;i<7;i++){const c=process.cpuUsage();canvasToCapabilityView(doc,{editingMachine:"m"});const d=process.cpuUsage(c);reps.push((d.user+d.system)/1000)}
  reps.sort((a,b)=>a-b);console.log(`seats=${seats} resources=${boards} median_ms=${reps[3]} best_ms=${reps[0]}`);
}

const fixture=JSON.parse(require("node:fs").readFileSync("e2e/scenarios/zz-proof-factory-shape.json","utf8")).model;
const doc=canvasOf(fixture.nodes,fixture.wires);
const seats=fixture.nodes.filter((n:any)=>n.kind==="agent").length;
const resources=fixture.nodes.filter((n:any)=>["task","artifacts","automations"].includes(n.kind)).length;
for(let i=0;i<3;i++) canvasToCapabilityView(doc,{editingMachine:"studio"});
const reps:number[]=[];
for(let i=0;i<9;i++){const c=process.cpuUsage();canvasToCapabilityView(doc,{editingMachine:"studio"});const d=process.cpuUsage(c);reps.push((d.user+d.system)/1000)}
reps.sort((a,b)=>a-b);console.log(`factory seats=${seats} resources=${resources} nodes=${fixture.nodes.length} wires=${fixture.wires.length} median_ms=${reps[4]} best_ms=${reps[0]}`);
