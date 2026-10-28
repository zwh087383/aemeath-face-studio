async page => {
  await page.waitForFunction(()=>window.motionLibrary?.snapshot().ready,null,{timeout:120000});
  const coordinates=await page.evaluate(async()=>{
    const THREE=await import('three'), api=window.motionLibrary, mesh=api.scene.mesh;
    api.scene.setView('face');
    const point=new THREE.Vector3();mesh.getVertexPosition(65527,point);mesh.localToWorld(point);
    const marker=new THREE.Mesh(new THREE.SphereGeometry(.055),new THREE.MeshBasicMaterial({color:0xf04040}));marker.position.copy(point);mesh.parent.parent.add(marker);
    return {chinWorld:point.toArray(),headWorld:mesh.skeleton.bones.find(b=>b.name==='頭').getWorldPosition(new THREE.Vector3()).toArray()};
  });
  await page.screenshot({path:'outputs/library-expansion-20261027/chin-marker-front.png'});
  await page.evaluate(()=>window.motionLibrary.scene.setView('side'));
  await page.screenshot({path:'outputs/library-expansion-20261027/chin-marker-side.png'});
  return coordinates;
}
