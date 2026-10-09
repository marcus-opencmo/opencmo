import bpy, math
from mathutils import Vector
from pathlib import Path
out=Path('/home/marcus/code/opencmo/assets/mascot')
# Tạo scene riêng để giữ nguyên scene có sẵn.
scene=bpy.data.scenes.new('OpenCMO Mascot')
bpy.context.window.scene=scene
with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
 parts=[]
 def mat(name,color):
  m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
  p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Roughness'].default_value=.36
  return m
 cream=mat('Warm ivory plastic',(.88,.82,.70)); dark=mat('Charcoal face',(.018,.015,.013)); joint=mat('Ivory joints',(.65,.60,.49))
 def cap(name,loc,dims,material=cream,taper=.80):
  x,y,z=[a/2 for a in dims]
  verts=[(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x*taper,-y*taper,z),(x*taper,-y*taper,z),(x*taper,y*taper,z),(-x*taper,y*taper,z)]
  mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]); mesh.update()
  ob=bpy.data.objects.new(name,mesh); scene.collection.objects.link(ob); ob.location=loc; ob.data.materials.append(material)
  mod=ob.modifiers.new('Soft keycap edges','BEVEL'); mod.width=min(dims)*.19; mod.segments=5
  ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL'); parts.append(ob); return ob
 def sphere(name,loc,scale,material):
  bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=16,location=loc); ob=bpy.context.object; ob.name=name; ob.scale=scale; ob.data.materials.append(material)
  for p in ob.data.polygons:p.use_smooth=True
  parts.append(ob); return ob
 head=cap('Head keycap',(0,0,3.35),(2.25,1.8,1.0)); head.rotation_euler[0]=math.pi/2
 cap('Slim torso',(0,0,1.95),(.87,.65,1.03),taper=.78)
 for side in [-1,1]:
  sphere('Shoulder joint',(side*.49,0,2.28),(.15,.15,.15),joint)
  for i in range(3):
   ob=cap(('Left' if side<0 else 'Right')+' arm key '+str(i),(side*(.65+i*.19),0,2.15-i*.34),(.34,.40,.38)); ob.rotation_euler[1]=side*-.35
   if i<2:sphere('Elbow connector',(side*(.74+i*.19),0,1.98-i*.34),(.095,.095,.12),joint)
  sphere('Hip',(side*.25,0,1.37),(.12,.12,.15),joint)
  ob=cap('Leg keycap',(side*.29,0,1.07),(.40,.44,.51)); ob.rotation_euler[1]=side*.12
  sphere('Ankle',(side*.32,0,.72),(.11,.11,.13),joint)
  cap('Foot keycap',(side*.35,-.09,.39),(.58,.73,.51))
 for x in [-.43,.43]:sphere('Eye',(x,-.53,3.47),(.095,.06,.14),dark)
 curve=bpy.data.curves.new('Smile curve','CURVE'); curve.dimensions='3D'; curve.bevel_depth=.026; curve.bevel_resolution=4
 sp=curve.splines.new('POLY'); sp.points.add(24)
 for i,p in enumerate(sp.points):
  t=math.pi+math.pi*i/24; p.co=(.19*math.cos(t),-.54,3.20+.10*math.sin(t),1)
 ob=bpy.data.objects.new('Smile',curve); scene.collection.objects.link(ob); ob.data.materials.append(dark); parts.append(ob)
 # Xuất riêng nhân vật, không đưa đèn và nền vào GLB.
 bpy.ops.object.select_all(action='DESELECT')
 for ob in parts:ob.select_set(True)
 bpy.context.view_layer.objects.active=head
 bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-mascot.glb'),export_format='GLB',use_selection=True,export_apply=True,use_active_scene=True)
 floor=mat('Backdrop',(.24,.26,.28))
 bpy.ops.mesh.primitive_plane_add(size=200); plane=bpy.context.object; plane.name='Studio floor'; plane.data.materials.append(floor)
 def aim(ob,point):ob.rotation_euler=(Vector(point)-ob.location).to_track_quat('-Z','Y').to_euler()
 bpy.ops.object.camera_add(location=(6,-10,5.1)); cam=bpy.context.object; aim(cam,(0,0,2.15)); cam.data.type='ORTHO'; cam.data.ortho_scale=5.4; scene.camera=cam
 for name,loc,power,size in [('Key',(-4,-6,8),950,5),('Fill',(5,-3,5),650,4),('Rim',(2,4,7),1100,3)]:
  bpy.ops.object.light_add(type='AREA',location=loc); ob=bpy.context.object; ob.name=name; ob.data.energy=power; ob.data.shape='DISK'; ob.data.size=size; aim(ob,(0,0,2))
 scene.render.engine='CYCLES'; scene.cycles.samples=32
 scene.render.resolution_x=1000; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
 scene.world=bpy.data.worlds.new('Studio world'); scene.world.use_nodes=True; scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.3,.3,.3,1)
 scene.render.filepath=str(out/'preview.png')
 bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-mascot.blend'))
 # Render sau khi MCP trả lời để tránh quá thời gian chờ.
 def render():
  bpy.ops.render.render(write_still=True)
  return None
 bpy.app.timers.register(render,first_interval=2)
 print('Saved mascot blend and GLB; preview render queued')
