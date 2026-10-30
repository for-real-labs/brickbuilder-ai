import AVFoundation
import AppKit
let outDir=URL(fileURLWithPath:CommandLine.arguments[1])
for path in CommandLine.arguments.dropFirst(2) {
 try autoreleasepool {
  let asset=AVURLAsset(url:URL(fileURLWithPath:path))
  guard let track=asset.tracks(withMediaType:.video).first else {fatalError("Missing video")}
  let desc=track.formatDescriptions as! [CMFormatDescription]
  guard desc.contains(where:{(CMFormatDescriptionGetExtension($0,extensionKey:kCMFormatDescriptionExtension_ContainsAlphaChannel) as? Bool)==true}) else {fatalError("Missing alpha metadata")}
  let reader=try AVAssetReader(asset:asset)
  let output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:128,kCVPixelBufferHeightKey as String:128])
  reader.add(output)
  guard reader.startReading() else {throw reader.error!}
  var all=Data(),samples=[[String:Int]](),index=0
  while let sample=output.copyNextSampleBuffer() {
   let pb=CMSampleBufferGetImageBuffer(sample)!
   CVPixelBufferLockBaseAddress(pb,.readOnly)
   let w=CVPixelBufferGetWidth(pb),h=CVPixelBufferGetHeight(pb),row=CVPixelBufferGetBytesPerRow(pb)
   let base=CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to:UInt8.self)
   guard w==128 && h==128 else {fatalError("Unexpected size \(w)x\(h)")}
   var rgba=[UInt8](repeating:0,count:w*h*4),clear=0,opaque=0,soft=0
   for y in 0..<h {for x in 0..<w {
    let i=y*row+x*4,o=(y*w+x)*4,a=Int(base[i+3])
    rgba[o+3]=UInt8(a)
    if a==0 {clear += 1} else if a==255 {opaque += 1} else {soft += 1}
    for c in 0..<3 {rgba[o+c]=a==0 ? 0:UInt8(min(255,(Int(base[i+2-c])*255+a/2)/a))}
   }}
   CVPixelBufferUnlockBaseAddress(pb,.readOnly)
   guard clear>6250 && opaque>1250 && soft>20 else {fatalError("Invalid alpha \(path) frame \(index): \(clear)/\(opaque)/\(soft)")}
   if index % 24==0 {samples.append(["frame":index,"clear":clear,"opaque":opaque,"soft":soft])}
   all.append(contentsOf:rgba);index += 1
  }
  guard reader.status == .completed else {throw reader.error!}
  let name=URL(fileURLWithPath:path).deletingPathExtension().lastPathComponent
  try all.write(to:outDir.appendingPathComponent(name+"-hevc.rgba"))
  let report:[String:Any] = ["clip":name,"frames":index,"contains_alpha":true,"samples":samples]
  try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:outDir.appendingPathComponent(name+"-hevc-alpha.json"))
  print(name,"decoded",index,"frames with alpha")
 }
}
