import { Test, TestingModule } from '@nestjs/testing';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import {
  AddVariantDto,
  AdjustStockDto,
  UpdateVariantDto,
} from './dto/product-variant.dto';

function createMockService() {
  return {
    createProduct: jest.fn(),
    findAll: jest.fn(),
    findOneById: jest.fn(),
    findOneBySlug: jest.fn(),
    updateProduct: jest.fn(),
    publish: jest.fn(),
    archive: jest.fn(),
    unarchive: jest.fn(),
    softDelete: jest.fn(),
    hardDelete: jest.fn(),
    addProductImages: jest.fn(),
    reorderProductImages: jest.fn(),
    updateProductImage: jest.fn(),
    removeProductImage: jest.fn(),
    addVariant: jest.fn(),
    updateVariant: jest.fn(),
    adjustStock: jest.fn(),
    removeVariant: jest.fn(),
  };
}

describe('ProductsController', () => {
  let controller: ProductsController;
  let service: ReturnType<typeof createMockService>;

  beforeEach(async () => {
    service = createMockService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }],
    }).compile();

    controller = module.get<ProductsController>(ProductsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findOne — UUIDv7 vs slug routing', () => {
    it('routes a UUIDv7 to findOneById', async () => {
      const uuidv7 = '018f2e0a-7abc-7def-89ab-0123456789ab';
      await controller.findOne(uuidv7);

      expect(service.findOneById).toHaveBeenCalledWith(uuidv7);
      expect(service.findOneBySlug).not.toHaveBeenCalled();
    });

    it('routes a non-UUID string to findOneBySlug', async () => {
      await controller.findOne('my-product-slug');

      expect(service.findOneBySlug).toHaveBeenCalledWith('my-product-slug');
      expect(service.findOneById).not.toHaveBeenCalled();
    });

    it('routes a UUIDv4 (wrong version) to findOneBySlug, not findOneById', async () => {
      // UUIDv4 has a '4' in the version position where v7 requires '7' —
      // ProductsController.findOne intentionally treats it as a slug lookup.
      const uuidv4 = '018f2e0a-7abc-4def-89ab-0123456789ab';
      await controller.findOne(uuidv4);

      expect(service.findOneBySlug).toHaveBeenCalledWith(uuidv4);
      expect(service.findOneById).not.toHaveBeenCalled();
    });
  });

  describe('route delegation', () => {
    it('create() delegates to productsService.createProduct', async () => {
      const dto = { name: 'X' } as CreateProductDto;
      await controller.create(dto);
      expect(service.createProduct).toHaveBeenCalledWith(dto);
    });

    it('findBySlug() delegates to productsService.findOneBySlug', async () => {
      await controller.findBySlug('a-slug');
      expect(service.findOneBySlug).toHaveBeenCalledWith('a-slug');
    });

    it('update() delegates with id and dto', async () => {
      const dto = { name: 'Y' } as UpdateProductDto;
      await controller.update('p1', dto);
      expect(service.updateProduct).toHaveBeenCalledWith('p1', dto);
    });

    it('publish()/archive()/unarchive() delegate with the product id', async () => {
      await controller.publish('p1');
      await controller.archive('p1');
      await controller.unarchive('p1');

      expect(service.publish).toHaveBeenCalledWith('p1');
      expect(service.archive).toHaveBeenCalledWith('p1');
      expect(service.unarchive).toHaveBeenCalledWith('p1');
    });

    it('softDelete() and hardDelete() delegate with the product id', async () => {
      await controller.softDelete('p1');
      await controller.hardDelete('p1');

      expect(service.softDelete).toHaveBeenCalledWith('p1');
      expect(service.hardDelete).toHaveBeenCalledWith('p1');
    });

    it('addVariant() delegates with product id and dto', async () => {
      const dto = { sku: 'S1', price: 10 } as AddVariantDto;
      await controller.addVariant('p1', dto);
      expect(service.addVariant).toHaveBeenCalledWith('p1', dto);
    });

    it('updateVariant()/adjustStock()/removeVariant() delegate with variantId', async () => {
      const updateDto = { price: 20 } as UpdateVariantDto;
      const stockDto = { delta: 5 } as AdjustStockDto;

      await controller.updateVariant('v1', updateDto);
      await controller.adjustStock('v1', stockDto);
      await controller.removeVariant('v1');

      expect(service.updateVariant).toHaveBeenCalledWith('v1', updateDto);
      expect(service.adjustStock).toHaveBeenCalledWith('v1', stockDto);
      expect(service.removeVariant).toHaveBeenCalledWith('v1');
    });
  });
});
