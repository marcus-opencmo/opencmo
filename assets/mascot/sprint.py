import bpy,math
from mathutils import Vector
from pathlib import Path
out=Path('/home/marcus/code/opencmo/assets/mascot')
s=bpy.context.scene;s.frame_set(1);s.name='Sprint 2s'
root=s.objects['Motion Root'];body=s.objects['Body Bounce']
for ob in s.objects:ob.animation_data_clear()
root.location=(0,0,0);root.rotation_euler=(0,0,0)
body.location=(0,0,1.9);body.rotation_euler=(0,0,0)
arms={v:s.objects['Arm Swing '+str(v)] for v in [-1,1]};legs={v:s.objects['Leg Swing '+str(v)] for v in [-1,1]}
for ob in [*arms.values(),*legs.values()]:ob.rotation_euler=(0,0,0)
bpy.context.view_layer.update()
def hinge(name,loc,parent):
 ob=bpy.data.objects.new(name,None);s.collection.objects.link(ob);ob.location=loc;bpy.context.view_layer.update();w=ob.matrix_world.copy();ob.parent=parent;ob.matrix_world=w;return ob
def attach(ob,parent):
 bpy.context.view_layer.update();w=ob.matrix_world.copy();ob.parent=parent;ob.matrix_world=w
elbows={};knees={}
for side in [-1,1]:
 elbows[side]=hinge('Sprint Elbow '+str(side),(side*.74,0,1.98),arms[side])
 knees[side]=hinge('Sprint Knee '+str(side),(side*.30,0,.85),legs[side])
 for ob in list(s.objects):
  if ob.type not in {'MESH','CURVE'}:continue
  x=ob.matrix_world.translation.x
  if (x<0)!=(side<0):continue
  if ob.name.startswith(('Left arm key 1','Left arm key 2','Right arm key 1','Right arm key 2','Elbow connector')):attach(ob,elbows[side])
  if ob.name.startswith(('Ankle','Foot keycap')):attach(ob,knees[side])
s.render.fps=24;s.frame_start=1;s.frame_end=49
cam=s.camera
# Sáu chu kỳ trong hai giây; thân chúi, khuỷu gập, chân sau co lên.
for f in range(1,50):
 t=(f-1)/48;p=12*math.pi*t
 root.location=(0,6-12*t,0);root.keyframe_insert('location',frame=f)
 body.location.z=1.80+.045*(1-math.cos(2*p))
 body.rotation_euler=(.40,.035*math.sin(p),.065*math.sin(p))
 body.keyframe_insert('location',frame=f);body.keyframe_insert('rotation_euler',frame=f)
 for side in [-1,1]:
  q=p+(0 if side<0 else math.pi);stride=math.sin(q)
  arms[side].rotation_euler.x=1.0*stride
  elbows[side].rotation_euler.x=-1.15+.20*stride
  legs[side].rotation_euler.x=-1.0*stride-.25
  knees[side].rotation_euler.x=.25+1.15*max(0,-stride)
  for ob in [arms[side],elbows[side],legs[side],knees[side]]:ob.keyframe_insert('rotation_euler',frame=f)
 # Camera bám theo một phần, vẫn nhìn thấy nhân vật chạy qua khung hình.
 follow=Vector((0,root.location.y*.78,0));cam.location=Vector((8,-5,4.5))+follow
 cam.rotation_euler=(Vector((0,0,2))+follow-cam.location).to_track_quat('-Z','Y').to_euler()
 cam.keyframe_insert('location',frame=f);cam.keyframe_insert('rotation_euler',frame=f)
s.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for ob in s.objects:
 if ob.type in {'MESH','CURVE','EMPTY'} and ob.name not in {'Studio floor','Cube'}:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-mascot-sprint.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_force_sampling=True,export_anim_slide_to_zero=True)
cam.data.ortho_scale=6.7
s.render.engine='CYCLES';s.cycles.samples=4;s.cycles.use_denoising=True
s.render.resolution_x=640;s.render.resolution_y=480;s.render.resolution_percentage=100
s.render.filepath=str(out/'sprint-frames/frame-')
bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-mascot-sprint.blend'))
print('SPRINT_SAVED')
