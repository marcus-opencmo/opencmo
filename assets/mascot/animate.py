import bpy, math
from mathutils import Vector
from pathlib import Path
out=Path('/home/marcus/code/opencmo/assets/mascot')
scene=bpy.context.scene
scene.name='Run Forward 2s'
parts=[o for o in scene.objects if o.type in {'MESH','CURVE'} and o.name!='Studio floor']
if any(o.parent for o in parts):raise RuntimeError('Hãy mở bản model tĩnh trước khi dựng animation lại.')
def pivot(name,loc,parent=None):
 ob=bpy.data.objects.new(name,None);scene.collection.objects.link(ob);ob.location=loc
 if parent:
  bpy.context.view_layer.update();world=ob.matrix_world.copy();ob.parent=parent;ob.matrix_world=world
 return ob
def attach(ob,parent):
 bpy.context.view_layer.update();world=ob.matrix_world.copy();ob.parent=parent;ob.matrix_world=world
root=pivot('Motion Root',(0,0,0))
body=pivot('Body Bounce',(0,0,1.9),root)
arms={};legs={}
for side in [-1,1]:
 arms[side]=pivot('Arm Swing '+str(side),(side*.49,0,2.28),body)
 legs[side]=pivot('Leg Swing '+str(side),(side*.25,0,1.37),body)
for ob in parts:
 side=-1 if ob.location.x<0 else 1
 if any(ob.name.startswith(n) for n in ['Left arm','Right arm','Elbow','Shoulder']):attach(ob,arms[side])
 elif any(ob.name.startswith(n) for n in ['Leg keycap','Foot keycap','Ankle','Hip']):attach(ob,legs[side])
 else:attach(ob,body)
scene.render.fps=30;scene.frame_start=1;scene.frame_end=61
# Bốn chu kỳ chạy trong hai giây, có chuyển động gốc về phía trước.
for frame in range(1,62):
 t=(frame-1)/60;phase=t*8*math.pi
 root.location=(.22*math.sin(math.pi*t),1.5-3*t,0)
 root.rotation_euler.z=.10*math.sin(2*math.pi*t)
 root.keyframe_insert('location',frame=frame);root.keyframe_insert('rotation_euler',frame=frame)
 body.location.z=1.9-.13+.07*(1-math.cos(2*phase))
 body.rotation_euler=(.08,.035*math.sin(phase),.045*math.sin(phase))
 body.keyframe_insert('location',frame=frame);body.keyframe_insert('rotation_euler',frame=frame)
 for side in [-1,1]:
  stride=math.sin(phase+(0 if side<0 else math.pi))
  arms[side].rotation_euler.x=.72*stride-.18
  legs[side].rotation_euler.x=-.60*stride
  arms[side].keyframe_insert('rotation_euler',frame=frame)
  legs[side].keyframe_insert('rotation_euler',frame=frame)
scene.frame_set(1)
bpy.ops.object.select_all(action='DESELECT')
for ob in [root,body,*arms.values(),*legs.values(),*parts]:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(out/'opencmo-mascot-run.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_force_sampling=True,export_anim_slide_to_zero=True)
cam=scene.camera;cam.location=(7,-11,5.5);cam.rotation_euler=(Vector((0,0,2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=7
scene.render.engine='CYCLES';scene.cycles.samples=12
scene.render.resolution_x=720;scene.render.resolution_y=720;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.filepath=str(out/'run-frames/frame-')
bpy.ops.wm.save_as_mainfile(filepath=str(out/'opencmo-mascot-run.blend'))
print('RUN_ANIMATION_SAVED: 2 seconds, 30fps, 3 units forward')
