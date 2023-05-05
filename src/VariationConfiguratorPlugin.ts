import { Unzipped, unzipSync, strToU8, Zippable } from "fflate";
import { AViewerPlugin, AssetManagerPlugin, IFile, IMaterial, IModel, Object3D, makeColorSvg, ViewerApp, Mesh } from "webgi";

export interface IConfiguratorVariation {
  name: string;
  prefix: string;
  title: string;
  icon: string;
  icons: string[];
  titles: string[];
  items: string[];
  itemFiles: (Blob | undefined)[];
  iconFiles: (Blob | undefined)[];
  selected?: number;
}
export class VariationConfiguratorPlugin extends AViewerPlugin<""> {
  public static readonly PluginType = "VariationConfiguratorPlugin";

  dependencies = [AssetManagerPlugin];
  enabled = true;

  baseUrl = "";

  variations: { objects: IConfiguratorVariation[]; materials: IConfiguratorVariation[] } = { objects: [], materials: [] };

  // selectedVariations: {objects: Record<string, number>, materials: Record<string, number>} = {objects: {}, materials: {}}

  private _getVariationId(variation: IConfiguratorVariation) {
    return this.utils.getName(variation);
  }
  async applyVariation(variation: IConfiguratorVariation, item: number | string, type: "objects" | "materials", force = false) {
    if (!this._viewer) return;
    const name = this._getVariationId(variation);
    if (typeof item === "number") item = variation.items[item];
    const index = variation.items.indexOf(item);
    if (index === -1) {
      this._viewer.console.warn(`Item ${item} not found`);
      return;
    }
    const blob: IFile | undefined = variation.itemFiles[index] as any; // incase dropped file.
    // if (blob && blob.name !== item) blob.name = item
    // const selected = this.selectedVariations[type][name]
    const selected = variation.selected;
    if (!force && selected === index) return;
    // this.selectedVariations[type][name] = index
    variation.selected = index;
    const manager = this._viewer.getManager()!;
    const path = this.utils.getItemPath(variation, index, type);
    if (type === "objects") {
      let nameRoot = this._viewer.scene.findObjectsByName(name).map((o) => o.modelObject);
      if (nameRoot.length === 0) {
        nameRoot = [(await this._viewer.createObject3D())!.modelObject];
        nameRoot[0].name = name;
      }
      this._viewer.renderEnabled = false;
      for (const root of nameRoot) {
        [...root.children].forEach((c) => ((c as any).dispose ?? c.removeFromParent)());
      }
      const objs = await this._loadObject(path, blob);
      if (!objs.length) {
        // add json file
        if (!path.endsWith("json")) this._viewer.console.warn(`Object ${path} not found`);
        return;
      }
      let first = false;
      for (const root of nameRoot) {
        [...root.children].forEach((c) => ((c as any).dispose ?? c.removeFromParent)());
        for (const obj of objs) {
          if (!first) root.add(obj.modelObject);
          else root.add(obj.modelObject.clone());
        }
        first = true;
      }
      // apply all selected materials again
      const promises = [];
      const selectedMatVars = this.variations.materials.filter((v) => v && typeof v.selected === "number");
      for (const mat of selectedMatVars) {
        promises.push(this.applyVariation(mat, mat.selected!, "materials", true));
      }
      await Promise.all(promises);
      this._viewer.renderEnabled = true;
    }
    if (type === "materials") {
      const material = await this._loadMaterial(path, blob);
      if (!material) {
        this._viewer.console.warn(`Material ${path} not found`);
        return;
      }
      material.userData.__isVariation = true;
      // const objects = this._viewer.scene.findObjectsByName(name);
      // for (const obj of objects) {
      //   obj.setMaterial?.(material);
      // }

      // this._viewer.traverseSceneObjects((o) => {
      //   if (o.setMaterial && o.material?.name === name) o.setMaterial(material);
      // });

      //   console.log(manager.materials?.applyMaterial(material, name), name);
      //   console.log(this.applyMaterial(material, name), name);
      this.applyMaterial(material, name);
    }
  }

  applyMaterial(material: IMaterial, nameOrUuid: string): boolean {
    const manager = this._viewer!.getManager()!;
    const mType = Object.getPrototypeOf(material).constructor.TYPE;
    let currentMats = manager.materials!.findMaterialsByName(nameOrUuid);
    if (!currentMats || currentMats.length < 1) currentMats = [manager.materials!.findMaterial(nameOrUuid) as any];
    let applied = false;
    for (const c of currentMats) {
      if (!c) continue;
      console.log(c.userData.__isVariation, nameOrUuid);
      if (c.userData.__isVariation) continue;
      const cType = Object.getPrototypeOf(c).constructor.TYPE;
      // console.log(cType, mType)
      if (cType === mType) {
        const n = c.name;
        c.copyProps(material); // todo: refresh env map intensity here?
        c.name = n;
        applied = true;
      } else {
        // if ((c as any)['__' + mType]) continue
        const newMat = (c as any)["__" + mType] || manager.materials!.generateFromTemplateType(mType);
        if (!newMat) continue;
        const n = c.name;
        newMat.copyProps(material);
        newMat.name = n;
        const meshes = c.userData.__appliedMeshes as Set<IModel<Mesh>>;
        for (const mesh of [...(meshes ?? [])]) {
          mesh?.setMaterial?.(newMat);
          if (mesh) applied = true;
        }
        (c as any)["__" + mType] = newMat;
      }
    }
    return applied;
  }

  protected async _loadMaterial(path: string, blob?: IFile) {
    return this._viewer?.getManager()?.importer?.importSinglePath<IMaterial>(path, { importedFile: blob });
  }

  protected async _loadObject(path: string, blob?: IFile) {
    return this._viewer?.getManager()?.importer?.importPath(path, {
      importedFile: blob,
      reimportDisposed: true,
    }) as Promise<IModel<Object3D>[]>;
  }

  protected _ty = ["objects", "materials"] as const; // for types
  protected _extForType = {
    objects: ["glb", "fbx", "obj", "gltf", "stl", "3dm", "json", "vjson"],
    materials: ["pmat", "dmat"],
    images: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"],
  };

  importConfig(config: any, folder?: Unzipped) {
    if (typeof config === "string") {
      config = JSON.parse(config);
    }
    if (config.baseUrl !== undefined) this.baseUrl = config.baseUrl;
    if (!folder && config.folder) {
      // todo
      if (typeof config.folder === "object") {
        folder = config.folder;
      } else if (typeof config.folder === "string") {
        folder = unzipSync(strToU8(config.folder));
      } else {
        folder = unzipSync(config.folder);
      }
    }
    for (const type of this._ty) {
      if (config[type]) {
        for (const obj of config[type]) {
          const vari: IConfiguratorVariation = {
            items: obj.items,
            prefix: obj.prefix,
            name: obj.name,
            title: obj.title || "",
            icon: obj.icon || "",
            icons: obj.icons ?? obj.items.map(() => ""),
            titles: obj.titles ?? obj.items.map(() => ""),
            itemFiles: [],
            iconFiles: [],
          };
          if (folder) {
            for (let i = 0; i < obj.items.length; i++) {
              const item = obj.items[i];
              const path = type + "/" + obj.prefix + item;
              const file = folder[path];
              vari.itemFiles[i] = !file ? undefined : new File([file], item);
              const icon = obj.icons[i];
              if (!icon) continue;
              const iconPath = type + "/" + obj.prefix + icon;
              const iconFile = folder[iconPath];
              vari.iconFiles[i] = !iconFile ? undefined : new File([iconFile], icon);
            }
          }
          this.variations[type].push(vari);
        }
      }
    }
  }

  async importPath(configPath: string) {
    if (configPath.endsWith(".json")) {
      const config = await this._viewer?.getManager()!.importer?.importSinglePath(configPath, { processImported: false });
      const pathname = configPath.split("?")[0];
      if (!this.baseUrl) this.baseUrl = pathname.substring(0, pathname.lastIndexOf("/") + 1);
      return this.importConfig(config);
    } else if (configPath.endsWith(".zip")) {
      // const folder = await this._viewer?.getManager()!.importer?.importSinglePath(configPath, {processImported: false})
      // return this.importConfig({}, folder)
      // todo;
      alert("not implemented");
    } else {
      // todo
      alert("not supported");
    }
  }

  getMaterials(name: string) {
    return this.variations.materials.find((v) => this.utils.getName(v) === name)?.items || [];
  }
  getObjects(name: string) {
    return this.variations.objects.find((v) => this.utils.getName(v) === name)?.items || [];
  }

  getMaterialVariations() {
    return this.variations.materials.map((v) => this.utils.getName(v));
  }
  getObjectVariations() {
    return this.variations.objects.map((v) => this.utils.getName(v));
  }

  readonly utils = {
    getName: (item: IConfiguratorVariation | { name?: string; prefix: string }) => {
      return item.name || item.prefix.replace(/^\//, "").replace(/\/$/, "").replaceAll("/", "_");
    },
    getTitle: (item: IConfiguratorVariation) => {
      return item.title || this.utils.getName(item);
    },
    getIcon: (variation: IConfiguratorVariation, type: "objects" | "materials") => {
      let icon = variation.icon;
      if ((icon && /^(\w+)\(([^)]*)\)/.exec(icon)) || /^#([A-Fa-f\d]+)$/.exec(icon)) icon = makeColorSvg(icon);
      if (!icon || !(icon.startsWith("http") && icon.startsWith("data:")))
        icon = this.utils.pathToIcon(this.baseUrl + type + "/" + variation.prefix + (icon || ""));
      return icon;
    },
    getItemIcon: (variation: IConfiguratorVariation, i: number, type: "objects" | "materials") => {
      const file = variation.iconFiles[i];
      if (file) return URL.createObjectURL(file);
      let icon = variation.icons[i];
      if ((icon && /^(\w+)\(([^)]*)\)/.exec(icon)) || /^#([A-Fa-f\d]+)$/.exec(icon)) icon = makeColorSvg(icon);
      if (!icon) icon = this.utils.pathToIcon(variation.items[i]);
      if (icon && !icon.startsWith("http") && !icon.startsWith("data:")) icon = this.baseUrl + type + "/" + variation.prefix + icon;
      return icon;
    },
    getItemTitle: (variation: IConfiguratorVariation, i: number) => variation.titles[i] || this.utils.pathToTitle(variation.items[i]),
    getItemPath: (variation: IConfiguratorVariation, i: number, type: "objects" | "materials") =>
      variation.items[i].startsWith("http") ? variation.items[i] : `${this.baseUrl}${type}/${variation.prefix}${variation.items[i]}`,

    pathToTitle: (item: string) =>
      item
        .split("/")
        .pop()!
        .replace(/\.[^.]*$/, ""),
    pathToIcon: (item: string) => item.replace(/\/$/, "").replace(/\.[^/.]+$/, "") + ".webp",
  };

  async onRemove(viewer: ViewerApp): Promise<void> {
    // this.selectedVariations.objects = {}
    // this.selectedVariations.materials = {}
    // todo: not removing variations. maybe in onDispose?
    return super.onRemove(viewer);
  }

  fromJSON(json: any): this | null {
    if (!super.fromJSON(json)) return null;
    this.importConfig(json);
    return this;
  }

  toJSON: any = undefined;

  // todo: toJSON cannot be async, make _exportConfiguratorState sync by adding __sourceBuffer to files like in AssetImporter.
  // async toJSON(): Promise<any> {
  //     let json = super.toJSON()
  //     const {config, folder} = await this._exportConfiguratorState()
  //     if (config) json = {...json, ...config}
  //     if (folder) json.folder = strFromU8(zipSync(folder))
  //     return json
  // }

  protected async _exportConfiguratorState() {
    let folder: Zippable | undefined = {
      objects: {} as Zippable,
      materials: {} as Zippable,
    };
    const config: any = {
      objects: [],
      materials: [],
      type: VariationConfiguratorPlugin.PluginType,
    };
    if (this.baseUrl) config.baseUrl = this.baseUrl;
    let makeZip = false;
    for (const type of this._ty) {
      for (const variation of this.variations[type]) {
        const v: any = { ...variation };
        delete v.itemFiles;
        delete v.iconFiles;
        config[type].push(v);

        const varPrefix = variation.prefix.replace(/^\//, "");
        const namePrefix = varPrefix.trimEnd().endsWith("/") ? "" : varPrefix.split("/").pop() || "";
        const prefix = varPrefix.replace(namePrefix, "").trimEnd().replace(/\/$/, "");
        const target: Zippable = {};
        let hasFiles = false;
        for (let i = 0; i < variation.items.length; i++) {
          const item = variation.items[i];
          const file = variation.itemFiles[i];
          const iconFile = variation.iconFiles[i];
          const icon = variation.icons[i];
          if (!file) {
            if (iconFile) alert("Icon file without model/material file not supported");
            continue;
          }
          target[namePrefix + item] = new Uint8Array(await file.arrayBuffer());
          if (iconFile && !icon) this._viewer?.console.error("Icon file without icon name");
          if (iconFile && icon) {
            target[namePrefix + icon] = new Uint8Array(await iconFile.arrayBuffer());
          }
          hasFiles = true;
        }

        if (!hasFiles) continue; // no files

        makeZip = true;

        const foldernames = prefix.split("/");
        let f = folder[type] as any;
        for (const foldername of foldernames) {
          if (!f[foldername]) f[foldername] = {};
          const ff = f[foldername];
          if (typeof ff !== "object") {
            // await this._viewer?.alert('Invalid prefix: ' + variation.prefix)
            throw new Error("Invalid prefix: " + variation.prefix); // this will stop the download
          }
          f = ff as Zippable;
        }
        Object.assign(f, target);
      }
    }
    if (!makeZip) folder = undefined;
    return { folder, config };
  }
}
